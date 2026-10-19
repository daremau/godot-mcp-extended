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
			return _cmd_shot()
		"quit":
			_tcp.stop()
			get_tree().quit()
			return {"ok": true, "result": "quitting"}
	return {"ok": false, "error": "unknown command (allowed: tree|read|shot|quit)"}


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


func _cmd_shot() -> Dictionary:
	var img := get_viewport().get_texture().get_image()
	if img == null or img.is_empty():
		return {"ok": false, "error": "no image (headless renderer?)"}
	DirAccess.make_dir_recursive_absolute("res://.signal")
	var rel := ".signal/shot-%d.png" % Time.get_ticks_msec()
	if img.save_png("res://" + rel) != OK:
		return {"ok": false, "error": "save failed"}
	return {"ok": true, "result": {"path": ProjectSettings.globalize_path("res://" + rel)}}
