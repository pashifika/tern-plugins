tern.css("branch-preview", tern.fs.read(tern.plugin.dir .. "/style.css"))

local previous = ""

local function cssString(value)
	return '"' .. value:gsub('[%z\1-\31\127"\\]', function(char)
		return string.format("\\%x ", string.byte(char))
	end) .. '"'
end

local function findBranch(node)
	if not node then
		return nil
	end
	if node.k == "seg" and node.id:sub(-4) == "/git" then
		local spans = node.p and node.p.spans
		local name = spans and spans[1] and spans[1].t
		if type(name) == "string" then
			return node.id, name
		end
	end
	for _, child in node.c or {} do
		local id, name = findBranch(child)
		if id then
			return id, name
		end
	end
	return nil
end

local function refresh(cx)
	-- Read only the composer's dock, never conversation history.
	local surface = cx.session:surface("@focused", {
		root = "dock",
		nodes = 256,
		depth = 16,
		max_chars = 4096,
	})
	local css = ""
	if type(surface) == "table" and surface.surface.role == "omp.session" then
		local id, name = findBranch(surface.main)
		if id then
			css = '.tn-pane.on .sf-dock[data-surface="omp.session"] [data-id='
				.. cssString(id) .. "] { --branch-preview-name: " .. cssString(name) .. "; }"
		end
	end
	if css ~= previous then
		tern.css("branch-preview-name", css)
		previous = css
	end
end

local function tick(cx)
	refresh(cx)
	tern.timer(500, tick)
end

tern.on("focus", function(_, cx)
	refresh(cx)
end)
tern.timer(0, tick)
