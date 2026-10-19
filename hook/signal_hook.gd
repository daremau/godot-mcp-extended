# signal_hook.gd — opt-in runtime hook for godot-mcp-extended (spec 04)
#
# INSTALL (manual, never automatic):
#   1. Copy this file to your project root as res://signal_hook.gd
#   2. Add autoload: [autoload] SignalHook="*res://signal_hook.gd"
#   3. Restart the game via the godot-mcp run_project tool.
#
# BEHAVIOR:
#   Dormant unless the process env var SIGNAL_HOOK=1 is set (the sidecar sets it
#   automatically when this file exists in the project being run).
#   When active, listens on 127.0.0.1 (ephemeral port, printed as [SIGNAL-PORT] <port>)
#   and answers length-prefixed JSON requests. Allow-listed commands only:
#   tree | read | shot | quit. No script loading, no file writes outside res://.signal.
extends Node

var _tcp: TCPServer = TCPServer.new()
var _port: int = 0
var _client: StreamPeerTCP = null
var _rx: PackedByteArray = PackedByteArray()
var _node_budget: int = 0

const MAX_FRAME := 4 * 1024 * 1024
const BANNED_TOKENS := ["set_", "load(", "OS.", "FileAccess", "DirAccess", "Engine",
	"quit(", "queue_free", "add_child", "remove_child", "free(", "save_", "delete",
	"Input", "ProjectSettings", "Thread", "Mutex", "Semaphore", "JavaScriptBridge"]


func _ready() -> void:
	if OS.get_environment("SIGNAL_HOOK") != "1":
		return
	var err := _tcp.listen(0, "127.0.0.1")
	if err != OK:
		push_error("[SIGNAL] hook failed to listen")
		return
	_port = _tcp.get_local_port()
	print("[SIGNAL-PORT] %d" % _port)


func _process(_delta: float) -> void:
	if _port == 0:
		return
	if _client == null or _client.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		if _tcp.is_connection_available():
			_client = _tcp.take_connection()
			_rx = PackedByteArray()
		return
	_pump()


func _pump() -> void:
	var available := _client.get_available_bytes()
	if available > 0:
		var res := _client.get_data(available)
		if res[0] == OK:
			_rx.append_array(res[1])
	while _rx.size() >= 4:
		var length := (_rx[0] << 24) | (_rx[1] << 16) | (_rx[2] << 8) | _rx[3]
		if length <= 0 or length > MAX_FRAME:
			_client = null
			_rx = PackedByteArray()
			return
		if _rx.size() < 4 + length:
			return
		var payload := _rx.slice(4, 4 + length)
		_rx = _rx.slice(4 + length)
		_answer(String(payload.get_string_from_utf8()))


func _answer(text: String) -> void:
	var response := {"ok": false, "error": "bad request"}
	var json := JSON.new()
	if json.parse(text) == OK and json.get_data() is Dictionary:
		response = _dispatch(json.get_data())
	var body := JSON.stringify(response).to_utf8_buffer()
	var frame := PackedByteArray([(body.size() >> 24) & 0xFF, (body.size() >> 16) & 0xFF, (body.size() >> 8) & 0xFF, body.size() & 0xFF])
	frame.append_array(body)
	_client.put_data(frame)


func _dispatch(req: Dictionary) -> Dictionary:
	match String(req.get("command", "")):
		"tree":
			return _cmd_tree(req)
		"read":
			return _cmd_read(req)
		"shot":
			return _cmd_shot(req)
		"press":
			return _cmd_press(req)
		"stats":
			return _cmd_stats()
		"quit":
			_tcp.stop()
			get_tree().quit()
			return {"ok": true, "result": "quitting"}
	return {"ok": false, "error": "unknown command (allowed: tree|read|shot|quit|press|stats)"}


func _resolve(target: String) -> Node:
	if target == "" or target == ".":
		return get_tree().current_scene
	if target.begins_with("/"):
		return get_tree().root.get_node_or_null(target)
	var scene := get_tree().current_scene
	if scene != null:
		var n := scene.get_node_or_null(target)
		if n != null:
			return n
	return get_tree().root.get_node_or_null(target)


func _cmd_tree(req: Dictionary) -> Dictionary:
	var node := _resolve(String(req.get("target", ".")))
	if node == null:
		return {"ok": false, "error": "no such node"}
	_node_budget = 50
	var max_depth: int = int(req.get("maxDepth", 3))
	return {"ok": true, "result": _dump(node, 0, max_depth)}


func _dump(node: Node, depth: int, max_depth: int) -> Dictionary:
	var info := {
		"path": String(node.get_path()),
		"type": node.get_class(),
		"visible": node.is_visible_in_tree() if node is CanvasItem else true,
		"position": str(node.position) if ("position" in node) else "",
		"children": [],
	}
	if depth >= max_depth or _node_budget <= 0:
		return info
	_node_budget -= 1
	for child in node.get_children():
		if _node_budget <= 0:
			break
		(info["children"] as Array).append(_dump(child, depth + 1, max_depth))
	return info


func _cmd_read(req: Dictionary) -> Dictionary:
	var source := String(req.get("expression", ""))
	if source == "":
		return {"ok": false, "error": "empty expression"}
	for token in BANNED_TOKENS:
		if token in source:
			return {"ok": false, "error": "blocked token: %s" % token}
	var node := _resolve(String(req.get("target", ".")))
	if node == null:
		return {"ok": false, "error": "no such node"}
	var expr := Expression.new()
	if expr.parse(source) != OK:
		return {"ok": false, "error": "parse: %s" % expr.get_error_text()}
	var value = expr.execute([], node)
	if expr.has_execute_failed():
		return {"ok": false, "error": "execution failed"}
	return {"ok": true, "result": _jsonable(value, 0)}


func _jsonable(value, depth: int):
	if depth > 4:
		return str(value)
	if value is Dictionary:
		var out := {}
		for k in value.keys():
			out[str(k)] = _jsonable(value[k], depth + 1)
		return out
	if value is Array:
		var arr := []
		for v in value.slice(0, 20):
			arr.append(_jsonable(v, depth + 1))
		return arr
	if value is Vector2 or value is Vector3 or value is Vector4 or value is Color:
		return str(value)
	if value is Object:
		return "<%s:%s>" % [value.get_class(), String(value.get_path()) if value is Node else ""]
	if value is String or value is bool or value is int or value is float or value == null:
		return value
	return str(value)


func _cmd_shot(req: Dictionary) -> Dictionary:
	var img := get_viewport().get_texture().get_image()
	if img == null or img.is_empty():
		return {"ok": false, "error": "no image (headless renderer?)"}
	DirAccess.make_dir_recursive_absolute("res://.signal")
	var rel := ".signal/shot-%d.png" % Time.get_ticks_msec()
	if img.save_png("res://" + rel) != OK:
		return {"ok": false, "error": "save failed"}
	var out := {"path": ProjectSettings.globalize_path("res://" + rel)}
	var include_image := bool(req.get("includeImage", req.get("include_image", true)))
	if include_image:
		var buf := img.save_png_to_buffer()
		if buf != null and buf.size() > 0 and buf.size() <= 2 * 1024 * 1024:
			out["base64"] = Marshalls.raw_to_base64(buf)
			out["mime"] = "image/png"
		else:
			out["base64_included"] = false
	return {"ok": true, "result": out}


func _cmd_press(req: Dictionary) -> Dictionary:
	var action := String(req.get("action", ""))
	if action == "" or not action.is_valid_identifier():
		return {"ok": false, "error": "invalid action"}
	if not InputMap.has_action(action):
		return {"ok": false, "error": "unknown action: %s" % action}
	Input.action_press(action)
	var hold_ms := int(req.get("holdMs", req.get("hold_ms", 120)))
	hold_ms = clampi(hold_ms, 0, 2000)
	if hold_ms <= 0:
		Input.action_release(action)
		return {"ok": true, "result": {"action": action, "held_ms": 0, "released": true}}
	# Release after a short delay without blocking the hook pump.
	get_tree().create_timer(float(hold_ms) / 1000.0).timeout.connect(_on_press_timeout.bind(action))
	return {"ok": true, "result": {"action": action, "held_ms": hold_ms, "scheduled_release": true}}


func _on_press_timeout(action: String) -> void:
	if InputMap.has_action(action) and Input.is_action_pressed(action):
		Input.action_release(action)


func _cmd_stats() -> Dictionary:
	var root := get_tree().root
	var count := 0
	var stack: Array = [root]
	while stack.size() > 0 and count < 5000:
		var cur: Node = stack.pop_back()
		count += 1
		for child in cur.get_children():
			stack.push_back(child)
	return {"ok": true, "result": {
		"fps": Engine.get_frames_per_second(),
		"physics_fps": Engine.physics_ticks_per_second,
		"process_frames": Engine.get_process_frames(),
		"physics_frames": Engine.get_physics_frames(),
		"time_scale": Engine.time_scale,
		"node_count": count,
		"static_memory": OS.get_static_memory_usage(),
	}} 
