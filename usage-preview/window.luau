local previous = ""
local scope = ".tn-pane.on .sf-dock[data-surface='omp.session'] [data-role='omp.composer.extras']"
local popup = tern.fs.read(tern.plugin.dir .. "/style.css")

local function cssString(value)
	return '"' .. value:gsub('[%z\1-\31\127"\\]', function(char)
		return string.format("\\%x ", string.byte(char))
	end) .. '"'
end

local function findCredits(node)
	if not node then
		return nil
	end
	if node.k == "seg" and node.id:sub(-6) == "/usage" then
		local spans = node.p and node.p.spans or {}
		local elementIndex = 0
		for index, span in spans do
			-- Tern emits unstyled runs as text nodes, not span elements.
			if span.s and span.s ~= "" then
				elementIndex += 1
			end
			if type(span.t) == "string" and span.t:match("^✦%s") then
				local separator = index > 1 and spans[index - 1].t:match("^%s*·%s*$")
				return node.id, elementIndex, separator and elementIndex - 1 or nil
			end
		end
	end
	for _, child in node.c or {} do
		local id, index, separator = findCredits(child)
		if id then
			return id, index, separator
		end
	end
	return nil
end

local function refresh(cx)
	-- Match only reset-credit spans in the focused composer's dock, never history.
	local surface = cx.session:surface("@focused", {
		root = "dock",
		nodes = 256,
		depth = 16,
		max_chars = 4096,
	})
	local css = ""
	if type(surface) == "table" and surface.surface.role == "omp.session" then
		local id, index, separator = findCredits(surface.main)
		if id then
			local segment = scope .. " .sf-seg[data-id=" .. cssString(id) .. "]"
			local credit = segment .. " .sf-seg-t > span:nth-child(" .. index .. ")"
			css = scope .. ", " .. scope .. " .sf-st-row, " .. scope .. " .sf-st-l, "
				.. scope .. " .sf-st-r, " .. segment .. ", " .. segment .. " .sf-seg-t { overflow: visible; }\n"
				.. segment .. " { position: relative; min-height: 22px; }\n"
				.. credit .. " { display: none; }\n"
				.. segment .. ":hover .sf-seg-t > span:nth-child(" .. index .. ") { " .. popup .. " }\n"
			if separator then
				css ..= segment .. " .sf-seg-t > span:nth-child(" .. separator .. ") { display: none; }\n"
			end
		end
	end
	if css ~= previous then
		tern.css("usage-preview", css)
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
