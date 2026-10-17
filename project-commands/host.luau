local tern = require("tern")
local bridge = require("./lib/bridge")
local editor = require("./lib/editor")
local ui = tern.ui
local states = setmetatable({}, { __mode = "v" })
local fields = { "id", "name", "cwd", "shell", "run" }
local formPrefix = "main.page.form."

-- Replace only our launch marker before Tern starts its default login shell.
tern.on("spawn", function(spec)
	local prefix = "tern-project-commands-exec:"
	local line = spec.args[#spec.args]
	if type(line) ~= "string" or line:sub(1, #prefix) ~= prefix then return nil end
	spec.program = bridge.bunPath()
	spec.args = { tern.plugin.dir .. "/helper.ts", "terminal" }
	local ok, launch = pcall(function()
		return tern.json.decode(tern.base64.decode(line:sub(#prefix + 1)))
	end)
	if ok and type(launch) == "table" and type(launch.root) == "string" and type(launch.id) == "string" then
		table.insert(spec.args, launch.root)
		table.insert(spec.args, launch.id)
	else
		tern.log.error("Invalid Project Commands terminal launch")
	end
	return spec
end)

local function text(key, value, style)
	return ui.node("text", { key = key, spans = { ui.span(value, style) } })
end

local function button(key, label, action, disabled, primary)
	return ui.el("button", {
		key = key,
		text = label,
		class = "pc-button" .. (if primary then " pc-primary" else "") .. (if disabled then " pc-disabled" else ""),
		attrs = { ["aria-disabled"] = disabled == true },
		actions = if disabled then nil else { click = action },
	})
end

local function live(state, cx)
	if states[cx.pane] ~= state then
		return false
	end
	for _, pane in tern.pane.list() do
		if pane.pane == cx.pane then
			return true
		end
	end
	states[cx.pane] = nil
	return false
end

local function request(state, cx, payload, done)
	if state.busy then
		return
	end
	state.busy, state.error, state.notice = true, nil, nil
	local ok, failure = pcall(function()
		bridge.call(payload, function(result, err)
			if not live(state, cx) then
				return
			end
			state.busy = false
			if err then
				state.error = tostring(err)
			elseif type(result) ~= "table" then
				state.error = "The helper returned no command configuration."
			else
				done(result)
				cx:open("tern-project-commands:refresh")
			end
			cx:render()
		end)
	end)
	if not ok then
		state.busy, state.error = false, tostring(failure)
	end
end

local function applySnapshot(state, snapshot)
	if state.root ~= snapshot.root then
		state.deleted = {}
	end
	state.root, state.path, state.revision = snapshot.root, snapshot.path, snapshot.revision
	state.commands = snapshot.commands
end

local function reload(state, cx)
	if state.form then
		return
	end
	request(state, cx, { op = "load", cwd = state.root }, function(snapshot)
		applySnapshot(state, snapshot)
	end)
end

local function deleteCommand(state, command, cx)
	request(state, cx, {
		op = "remove", root = state.root, revision = state.revision, id = command.id,
	}, function(result)
		applySnapshot(state, result.snapshot)
		table.insert(state.deleted, { deleted = result.deleted, name = command.name })
		state.notice = 'Deleted "' .. command.name .. '".'
	end)
end

local function undoDelete(state, cx)
	if state.busy or state.form or #state.deleted == 0 then
		return
	end
	local entry = state.deleted[#state.deleted]
	request(state, cx, {
		op = "restore", root = state.root, revision = state.revision, deleted = entry.deleted,
	}, function(snapshot)
		applySnapshot(state, snapshot)
		table.remove(state.deleted)
		state.notice = 'Restored "' .. entry.name .. '".'
	end)
end

local function focus(state, id, cx)
	state.focus = id
	-- Create newly added fields before the raw focus op, which bypasses the view diff.
	cx:render()
	cx:frame({ { "focus", id or tern.json.null } })
end

local function fieldFor(state, id)
	if not state.form or type(id) ~= "string" then
		return nil
	end
	for _, name in fields do
		if id == formPrefix .. name .. ".input" then
			return state.form[name], name == "run"
		end
	end
	for _, row in state.form.env do
		local prefix = formPrefix .. "env.rows." .. row.id .. "."
		if id == prefix .. "key" then
			return row.key, false
		elseif id == prefix .. "value" then
			return row.value, false
		end
	end
	return nil
end

local function addEnv(state, key, value)
	state.nextEnv += 1
	local row = { id = "e" .. state.nextEnv, key = editor.new(key), value = editor.new(value) }
	table.insert(state.form.env, row)
	return row
end

local function beginForm(state, command, cx)
	if state.busy or not state.revision then
		return
	end
	local original = command or {
		id = "", name = "", cwd = ".", shell = if tern.runtime.os == "macos" then "zsh" else "sh",
		run = "", enabled = true, execution = "background", profiles = true, env = {},
	}
	local form = { env = {}, enabled = original.enabled, background = original.execution == "background", profiles = original.profiles, originalId = if command then command.id else nil }
	for _, name in fields do
		form[name] = editor.new(original[name])
	end
	state.form, state.error, state.notice = form, nil, nil
	local names = {}
	for key in original.env do
		table.insert(names, key)
	end
	table.sort(names)
	for _, key in names do
		addEnv(state, key, original.env[key])
	end
	focus(state, formPrefix .. "id.input", cx)
end

local function cancel(state, cx)
	if state.busy then
		return
	end
	state.form, state.error, state.notice = nil, nil, nil
	focus(state, nil, cx)
end

local function commandFromForm(state)
	local form = state.form
	local command = { enabled = form.enabled, execution = if form.background then "background" else "tab", profiles = form.profiles, env = {} }
	for _, name in fields do
		command[name] = form[name].text
	end
	if not command.id:match("^[a-z][a-z0-9%-]*$") then
		return nil, "ID must start with a lowercase letter and contain only lowercase letters, digits, or hyphens."
	end
	for _, existing in state.commands do
		if existing.id == command.id and existing.id ~= form.originalId then
			return nil, "A command with this ID already exists."
		end
	end
	if not command.name:match("%S") then
		return nil, "Name is required."
	end
	if not command.run:match("%S") then
		return nil, "Run script is required."
	end
	if command.cwd == "" then
		command.cwd = "."
	end
	if command.shell == "" then
		command.shell = if tern.runtime.os == "macos" then "zsh" else "sh"
	end
	for _, row in form.env do
		local key = row.key.text
		if not key:match("^[A-Za-z_][A-Za-z0-9_]*$") then
			return nil, "Environment keys must match [A-Za-z_][A-Za-z0-9_]*. Remove unused rows."
		end
		if command.env[key] ~= nil then
			return nil, "Environment key is repeated: " .. key
		end
		command.env[key] = row.value.text
	end
	return command, nil
end

local function saveForm(state, cx)
	if state.busy or not state.form then
		return
	end
	local command, err = commandFromForm(state)
	if err then
		state.error = err
		return
	end
	request(state, cx, {
		op = "save", root = state.root, revision = state.revision,
		originalId = state.form.originalId, command = command,
	}, function(snapshot)
		applySnapshot(state, snapshot)
		state.form, state.notice = nil, "Command saved."
		focus(state, nil, cx)
	end)
end

local function inputField(state, key, label, placeholder)
	local field = state.form[key]
	return ui.el("div", { key = key, class = "pc-field" }, {
		text("label", label, "muted"),
		ui.node(if key == "run" then "editor" else "input", {
			key = "input", text = field.text, cursor = field.cursor, anchor = field.anchor,
			aria = label, placeholder = placeholder, readonly = state.busy,
			maxLines = if key == "run" then 10 else nil,
			lang = if key == "run" then "bash" else nil,
		}),
	})
end

local function formView(state)
	local form = state.form
	local envRows = {}
	for _, row in form.env do
		table.insert(envRows, ui.el("div", { key = row.id, class = "pc-env-row" }, {
			ui.node("input", {
				key = "key", text = row.key.text, cursor = row.key.cursor, anchor = row.key.anchor,
				placeholder = "KEY", aria = "Environment key", readonly = state.busy,
			}),
			ui.node("input", {
				key = "value", text = row.value.text, cursor = row.value.cursor, anchor = row.value.anchor,
				placeholder = "value (may be empty)", aria = "Environment value", readonly = state.busy,
			}),
			button("remove", "Remove", "remove-env=" .. row.id, state.busy),
		}))
	end
	return ui.node("col", { key = "form", role = "project-commands.form" }, {
		text("heading", if form.originalId then "Edit command" else "New command", "strong"),
		inputField(state, "id", "ID", "build-project"),
		inputField(state, "name", "Name", "Build project"),
		inputField(state, "cwd", "Working directory (relative to project root)", "."),
		inputField(state, "shell", "Shell (name or absolute path)", "zsh / fish"),
		ui.el("label", { key = "profiles", class = "pc-enabled" }, {
			ui.el("input", { key = "check", type = "checkbox", name = "profiles", checked = form.profiles, disabled = state.busy }),
			text("label", "Load shell profiles — " .. (if form.profiles then "On" else "Off")),
		}),
		ui.el("label", { key = "enabled", class = "pc-enabled" }, {
			ui.el("input", { key = "check", type = "checkbox", name = "enabled", checked = form.enabled, disabled = state.busy }),
			text("label", "Enabled — " .. (if form.enabled then "On" else "Off")),
		}),
		ui.el("label", { key = "background", class = "pc-enabled" }, {
			ui.el("input", { key = "check", type = "checkbox", name = "background", checked = form.background, disabled = state.busy }),
			text("label", "Run in background — " .. (if form.background then "On" else "Off (new terminal tab)")),
		}),
		inputField(state, "run", "Run (multiline shell script)", "bun run build\nbun run preview"),
		ui.node("col", { key = "env" }, {
			text("label", "Environment variables", "strong"),
			text("hint", "Stored as plain text in the project YAML file. Do not store secrets here.", "muted"),
			ui.node("col", { key = "rows" }, envRows),
			button("add", "Add variable", "add-env", state.busy),
		}),
	})
end

local function commandsView(state)
	local commands = {}
	for _, command in state.commands do
		local keys = {}
		for key in command.env do
			table.insert(keys, key)
		end
		table.sort(keys)
		table.insert(commands, ui.node("col", { key = command.id, role = "project-commands.command" }, {
			ui.node("row", { key = "heading" }, {
				text("name", command.name, "strong"),
				ui.node("badge", { key = "enabled", text = if command.enabled then "On" else "Off", tone = if command.enabled then "success" else "muted" }),
			}),
			text("id", command.id, "muted"),
			text("cwd", "cwd: " .. command.cwd, "muted"),
			text("shell", "shell: " .. command.shell, "muted"),
			text("execution", "execution: " .. command.execution, "muted"),
			text("profiles", "profiles: " .. (if command.profiles then "On" else "Off"), "muted"),
			text("env", "env: " .. (if #keys == 0 then "none" else table.concat(keys, ", ")), "muted"),
			ui.node("code", { key = "script", text = command.run, lang = "bash", role = "project-commands.script" }),
			ui.node("row", { key = "actions", role = "project-commands.actions" }, {
				button("run", "Run", "run=" .. command.id, state.busy or not command.enabled, true),
				button("edit", "Edit", "edit=" .. command.id, state.busy),
				button("toggle", if command.enabled then "Turn Off" else "Turn On", "toggle=" .. command.id, state.busy),
				button("delete", "Delete", "delete=" .. command.id, state.busy),
			}),
		}))
	end
	if #commands == 0 and state.revision then
		table.insert(commands, text("empty", "No commands yet. Choose New command to create one.", "muted"))
	end
	return ui.node("col", { key = "commands" }, commands)
end

local function focusNext(state, reverse, cx)
	local ids = {}
	for _, name in fields do
		table.insert(ids, formPrefix .. name .. ".input")
	end
	for _, row in state.form.env do
		table.insert(ids, formPrefix .. "env.rows." .. row.id .. ".key")
		table.insert(ids, formPrefix .. "env.rows." .. row.id .. ".value")
	end
	local index = table.find(ids, state.focus) or 1
	index = ((index - 1 + (if reverse then -1 else 1)) % #ids) + 1
	focus(state, ids[index], cx)
end

tern.block.define("manager", {
	features = { "edit", "undo" },
	init = function(cx, args, saved)
		local state = {
			root = args[1] or (if type(saved) == "table" then saved.root else nil) or cx.cwd or tern.getenv("HOME") or "/",
			commands = {}, deleted = {}, busy = false, nextEnv = 0,
		}
		states[cx.pane] = state
		reload(state, cx)
		return state
	end,
	title = function(state)
		return if state.form then "Project Commands — " .. (if state.form.originalId then "Edit" else "New") else "Project Commands"
	end,
	view = function(state)
		local page = {
			text("title", "Project Commands", "strong"),
			text("path", state.path or (state.root .. "/.omp/tern-commands.yaml"), "muted"),
		}
		if state.error then
			table.insert(page, ui.node("text", { key = "error", role = "project-commands.error", tone = "error", spans = { ui.span(state.error, "error") } }))
		end
		if state.notice then
			table.insert(page, text("notice", state.notice, "success"))
		end
		if state.busy then
			table.insert(page, text("busy", "Working…", "muted"))
		end
		if state.form then
			table.insert(page, formView(state))
		else
			table.insert(page, ui.node("row", { key = "toolbar", role = "project-commands.actions" }, {
				button("new", "New command", "new", state.busy or not state.revision, true),
				button("reload", "Reload", "reload", state.busy),
				button("undo", "Undo delete (" .. tostring(#state.deleted) .. ")", "undo-delete", state.busy or #state.deleted == 0),
			}))
			if #state.deleted > 0 then
				table.insert(page, text("undo-hint", "Deletion undo is available until this manager closes.", "muted"))
			end
			table.insert(page, commandsView(state))
		end
		local dock
		if state.form then
			dock = ui.node("col", { role = "project-commands.dock" }, {
				ui.node("row", { key = "actions", role = "project-commands.actions" }, {
					button("save", "Save", "save", state.busy, true),
					button("cancel", "Cancel", "cancel", state.busy),
					text("hint", "Tab: next field · Cmd/Ctrl+S: save · Esc: cancel", "muted"),
				}),
			})
		end
		return {
			main = ui.node("col", { role = "project-commands.main" }, {
				ui.el("div", { key = "page", class = "pc-page" }, page),
			}),
			dock = dock,
		}
	end,
	event = function(state, ev, cx)
		if state.busy then
			return
		end
		if ev.ev == "focus" then
			if fieldFor(state, ev.id) then
				focus(state, ev.id, cx)
			end
		elseif ev.ev == "undo" and not state.form then
			undoDelete(state, cx)
		elseif ev.ev == "edit" or ev.ev == "undo" then
			local field, multiline = fieldFor(state, ev.id)
			if not field then
				return
			end
			state.focus = ev.id
			if ev.ev == "edit" then
				editor.edit(field, ev, multiline)
			else
				editor.undo(field, false)
			end
		elseif ev.ev == "change" and state.form and ev.id == formPrefix .. "enabled.check" then
			state.form.enabled = ev.checked == true
		elseif ev.ev == "change" and state.form and ev.id == formPrefix .. "background.check" then
			state.form.background = ev.checked == true
		elseif ev.ev == "change" and state.form and ev.id == formPrefix .. "profiles.check" then
			state.form.profiles = ev.checked == true
		elseif ev.ev == "action" then
			local action = ev.act
			if state.form then
				if action == "save" then
					saveForm(state, cx)
				elseif action == "cancel" then
					cancel(state, cx)
				elseif action == "add-env" then
					local row = addEnv(state, "", "")
					focus(state, formPrefix .. "env.rows." .. row.id .. ".key", cx)
				elseif action == "remove-env" then
					for index, row in state.form.env do
						if row.id == ev.value then
							table.remove(state.form.env, index)
							local prefix = formPrefix .. "env.rows." .. row.id .. "."
							if state.focus and state.focus:sub(1, #prefix) == prefix then
								focus(state, formPrefix .. "run.input", cx)
							end
							break
						end
					end
				end
			elseif action == "new" then
				beginForm(state, nil, cx)
			elseif action == "reload" then
				reload(state, cx)
			elseif action == "undo-delete" then
				undoDelete(state, cx)
			else
				for _, command in state.commands do
					if command.id == ev.value then
						if action == "edit" then
							beginForm(state, command, cx)
						elseif action == "delete" then
							deleteCommand(state, command, cx)
						elseif action == "toggle" then
							request(state, cx, {
								op = "toggle", root = state.root, revision = state.revision, id = command.id, enabled = not command.enabled,
							}, function(snapshot)
								applySnapshot(state, snapshot)
							end)
						elseif action == "run" and command.enabled then
							cx:open("tern-project-commands:run/" .. command.id)
						end
						break
					end
				end
			end
		end
	end,
	key = function(state, key, cx)
		if state.busy then
			return false
		end
		if not state.form then
			if (key.meta or key.ctrl) and key.name == "z" and not key.shift and not key.alt then
				undoDelete(state, cx)
				return true
			end
			return false
		end
		if (key.meta or key.ctrl) and key.name == "s" then
			saveForm(state, cx)
			return true
		elseif key.name == "escape" then
			cancel(state, cx)
			return true
		elseif key.name == "tab" and not key.ctrl and not key.meta then
			focusNext(state, key.shift, cx)
			return true
		end
		local field, multiline = fieldFor(state, state.focus)
		if not field then
			return false
		end
		if key.name == "enter" and not multiline and not key.ctrl and not key.meta then
			focusNext(state, false, cx)
			return true
		end
		return editor.key(field, key, multiline, function(value)
			cx:copy(value)
		end)
	end,
	save = function(state)
		return { root = state.root }
	end,
})
