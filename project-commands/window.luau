local bridge = require("./lib/bridge")
local pending = {}
local paletteSnapshot
local projectIds = {}
local nextProjectId = 1
local refreshEpoch = 0
local refreshTimer

local function localPane(cx, pane)
	for _, host in ipairs(cx.hosts:list()) do
		if host.kind == "local" then
			for _, id in ipairs(host.panes) do
				if id == pane then return true end
			end
		end
	end
	return false
end

local function runBackground(cx, launch)
	bridge.call({ op = "run", root = launch.root, id = launch.id }, function(result, err, fresh)
		local context = fresh or cx
		if err then
			context:toast("error", "Cannot run command", err)
		elseif result.status == 0 then
			context:toast("success", result.name .. " — succeeded")
		else
			context:toast("error", result.name .. " — failed (exit " .. tostring(result.status) .. ")", result.logPath)
			if result.logPath and context.hosts:current().kind == "local" then
				context:open(result.logPath, "tab")
			end
		end
	end)
end

local function runInNewTerminal(cx, launch)
	local payload = tern.base64.encode(tern.json.encode({ root = launch.root, id = launch.id }), { url = true })
	local pane = cx.hosts:terminal("local", { cwd = launch.cwd, command = "tern-project-commands-exec:" .. payload })
	local tab = cx.session:tab_of(pane)
	if tab then cx.layout:name_tab(tab, launch.name) end
end

local function runCommand(cx, source, root, id)
	if pending[source] then return end
	local original = cx.session:pane(source)
	if not original or not localPane(cx, source) then return end
	pending[source] = true
	bridge.call({ op = "prepare", root = root, id = id }, function(launch, err, fresh)
		pending[source] = nil
		local context = fresh or cx
		if err then context:toast("error", "Cannot run command", err); return end
		local current = context.session:pane(source)
		if not current or current.cwd ~= original.cwd or not localPane(context, source) then return end
		if launch.execution == "background" then
			runBackground(context, launch)
		else
			runInNewTerminal(context, launch)
		end
	end)
end

local function availableCommand(cx, root, id)
	local snapshot = paletteSnapshot
	if not snapshot or snapshot.root ~= root or not snapshot.enabled[id] then return false end
	if cx.session:focused() ~= snapshot.pane then return false end
	local pane = cx.session:pane(snapshot.pane)
	return pane ~= nil and pane.cwd == snapshot.cwd
end

local function populatePalette(snapshot, source, cwd)
	-- A stale palette row must never resolve to another project's command with the same ID.
	if not projectIds[snapshot.root] then
		projectIds[snapshot.root] = nextProjectId
		nextProjectId += 1
	end
	paletteSnapshot = { root = snapshot.root, pane = source, cwd = cwd, enabled = {} }
	for _, command in ipairs(snapshot.commands) do
		local root, id = snapshot.root, command.id
		paletteSnapshot.enabled[id] = command.enabled
		local definition = {
			id = "run_" .. projectIds[root] .. "_" .. id,
			title = "Project Commands: " .. command.name,
			icon = "terminal",
			available = function(cx)
				return availableCommand(cx, root, id)
			end,
			run = function(cx)
				if not availableCommand(cx, root, id) then
					cx:toast("error", "This command is no longer available in the focused project.")
					return
				end
				runCommand(cx, paletteSnapshot.pane, root, id)
			end,
		}
		tern.command(definition)
	end
end

local function schedulePaletteRefresh()
	refreshEpoch += 1
	local epoch = refreshEpoch
	paletteSnapshot = nil
	if refreshTimer then refreshTimer:cancel() end
	refreshTimer = tern.timer(0, function(cx)
		refreshTimer = nil
		local source = cx.session:focused()
		local info = source and cx.session:pane(source)
		if not info or not info.cwd or info.cwd == "" or not localPane(cx, source) then return end
		local cwd = info.cwd
		bridge.call({ op = "load", cwd = cwd }, function(snapshot, err, fresh)
			if epoch ~= refreshEpoch then return end
			local context = fresh or cx
			local current = context.session:pane(source)
			if context.session:focused() ~= source or not current or current.cwd ~= cwd or not localPane(context, source) then return end
			if err then context:toast("error", "Cannot refresh project commands", err); return end
			populatePalette(snapshot, source, cwd)
		end)
	end)
end

tern.on("window_start", schedulePaletteRefresh)
tern.on("focus", schedulePaletteRefresh)
tern.on("pane_closed", schedulePaletteRefresh)
tern.on("cwd", function(ev, cx)
	if cx.session:focused() == ev.pane then schedulePaletteRefresh() end
end)
-- window_start does not fire again when an already loaded plugin is reloaded.
schedulePaletteRefresh()

tern.command({
	id = "open",
	title = "Project Commands: Open manager",
	icon = "terminal",
	run = function(cx)
		local source = cx.session:focused()
		local info = source and cx.session:pane(source)
		if not info or not info.cwd or info.cwd == "" or not localPane(cx, source) then
			cx:toast("error", "Open Project Commands from a local project pane.")
			return
		end
		bridge.call({ op = "load", cwd = info.cwd }, function(snapshot, err, fresh)
			local context = fresh or cx
			if err then context:toast("error", "Cannot load project commands", err); return end
			if not context.session:pane(source) then return end
			if context.hosts:current().kind ~= "local" then
				context:toast("error", "Return to the local host before opening Project Commands.")
				return
			end
			local pane = context.layout:new_tab({
				cwd = snapshot.root,
				block = "project-commands.manager",
				args = { snapshot.root },
			})
			if not pane then context:toast("error", "Project Commands could not open. Check that its host plugin is enabled.") end
		end)
	end,
})

tern.route.link(function(link, cx)
	if link.url:sub(1, 22) ~= "tern-project-commands:" then return nil end
	local refresh = link.url == "tern-project-commands:refresh"
	local id = link.url:match("^tern%-project%-commands:run/([a-z][a-z0-9%-]*)$")
	local pane = link.pane
	local info = pane and cx.session:pane(pane)
	if (not refresh and not id) or not info or info.block ~= "project-commands.manager" or not localPane(cx, pane) then
		cx:toast("error", "Use project command links from the Project Commands manager.")
		return { handled = true }
	end
	if refresh then
		schedulePaletteRefresh()
	else
		runCommand(cx, pane, info.cwd, id)
	end
	return { handled = true }
end)
