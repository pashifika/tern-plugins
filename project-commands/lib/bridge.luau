local bridge = {}

local function bunPath()
	local configured = tern.getenv("TERN_PROJECT_COMMANDS_BUN")
	if configured and configured ~= "" then return configured end
	local home = tern.getenv("HOME")
	if home and tern.fs.exists(home .. "/.bun/bin/bun") then return home .. "/.bun/bin/bun" end
	if tern.fs.exists("/opt/homebrew/bin/bun") then return "/opt/homebrew/bin/bun" end
	return "bun"
end

function bridge.call(request, callback)
	local ok, err = pcall(function()
		tern.process.run({ bunPath(), tern.plugin.dir .. "/helper.ts", "rpc" }, {
			cwd = tern.plugin.dir,
			stdin = tern.json.encode(request),
			timeout_ms = 15000,
		}, function(result, cx)
			if result.status ~= 0 then
				local message = result.stderr ~= "" and result.stderr or "Command helper failed. Install Bun and run bun install in the plugin directory."
				callback(nil, message, cx)
				return
			end
			local decoded, value = pcall(tern.json.decode, result.stdout)
			if not decoded then
				callback(nil, "Invalid helper response: " .. tostring(value), cx)
				return
			end
			callback(value, nil, cx)
		end)
	end)
	if not ok then callback(nil, tostring(err)) end
end

return bridge
