local editor = {}

function editor.length(text)
	local units = 0
	for _, codepoint in utf8.codes(text) do
		units += if codepoint > 0xFFFF then 2 else 1
	end
	return units
end

-- Surface offsets are UTF-16 units; Luau string slices use UTF-8 bytes.
local function boundary(text, offset)
	local units = 0
	for byte, codepoint in utf8.codes(text) do
		local width = if codepoint > 0xFFFF then 2 else 1
		if units + width > offset then
			return byte, units
		end
		units += width
	end
	return #text + 1, units
end

function editor.new(text)
	return { text = text, cursor = editor.length(text), undo = {}, redo = {} }
end

local function snapshot(field)
	return { text = field.text, cursor = field.cursor, anchor = field.anchor }
end

local function restore(field, value)
	field.text, field.cursor, field.anchor = value.text, value.cursor, value.anchor
end

local function selected(field)
	return math.min(field.cursor, field.anchor or field.cursor), math.max(field.cursor, field.anchor or field.cursor)
end

local function splice(field, from, to, text, cursor)
	local first = boundary(field.text, from)
	local last = boundary(field.text, to)
	local updated = field.text:sub(1, first - 1) .. text .. field.text:sub(last)
	local changed = updated ~= field.text
	if changed then
		table.insert(field.undo, snapshot(field))
		field.redo = {}
	end
	field.text = updated
	local _, normalized = boundary(updated, math.max(0, cursor))
	field.cursor, field.anchor = normalized, nil
	return changed
end

function editor.edit(field, event, multiline)
	local length = editor.length(field.text)
	if event.len ~= length then
		return false
	end
	if type(event.from) ~= "number" or type(event.to) ~= "number" or type(event.cursor) ~= "number"
		or type(event.text) ~= "string" or event.from % 1 ~= 0 or event.to % 1 ~= 0
		or event.cursor % 1 ~= 0 or event.from < 0 or event.to < event.from or event.to > length then
		return false
	end
	local text = if multiline then event.text else event.text:gsub("[\r\n]", " ")
	splice(field, event.from, event.to, text, event.cursor)
	return true
end

function editor.undo(field, redo)
	local source = if redo then field.redo else field.undo
	local target = if redo then field.undo else field.redo
	local previous = table.remove(source)
	if not previous then
		return false
	end
	table.insert(target, snapshot(field))
	restore(field, previous)
	return true
end

local function move(field, position, select)
	local _, normalized = boundary(field.text, math.max(0, position))
	if select then
		field.anchor = field.anchor or field.cursor
	else
		field.anchor = nil
	end
	field.cursor = normalized
end

local function previous(field)
	local units, prior = 0, 0
	for _, codepoint in utf8.codes(field.text) do
		if units >= field.cursor then
			break
		end
		prior = units
		units += if codepoint > 0xFFFF then 2 else 1
	end
	return prior
end

local function following(field)
	local byte = boundary(field.text, field.cursor)
	if byte > #field.text then
		return field.cursor
	end
	return field.cursor + (if utf8.codepoint(field.text, byte) > 0xFFFF then 2 else 1)
end

local function lineBounds(field)
	local byte = boundary(field.text, field.cursor)
	local prefix = field.text:sub(1, byte - 1)
	local startByte = (prefix:match(".*()\n") or 0) + 1
	local endByte = field.text:find("\n", byte, true) or (#field.text + 1)
	return editor.length(field.text:sub(1, startByte - 1)), editor.length(field.text:sub(1, endByte - 1)), startByte, endByte
end

local function wordEdge(field, forward)
	local byte = boundary(field.text, field.cursor)
	if forward then
		local suffix = field.text:sub(byte)
		local matched = suffix:match("^%s*[^%s]*") or ""
		return field.cursor + editor.length(matched)
	end
	local prefix = field.text:sub(1, byte - 1)
	local matched = prefix:match("[^%s]*%s*$") or ""
	return field.cursor - editor.length(matched)
end

-- Native selection edits consume their keys in Tern; only remaining keys reach this fallback.
function editor.key(field, key, multiline, copy)
	local name = key.name
	local chord = key.meta or key.ctrl
	if chord and name == "z" then
		return editor.undo(field, key.shift)
	elseif chord and name == "a" then
		field.anchor, field.cursor = 0, editor.length(field.text)
		return true
	elseif chord and (name == "c" or name == "x") then
		local from, to = selected(field)
		if from == to then
			return false
		end
		local first, last = boundary(field.text, from), boundary(field.text, to)
		copy(field.text:sub(first, last - 1))
		if name == "x" then
			splice(field, from, to, "", from)
		end
		return true
	elseif name == "left" or name == "right" then
		local from, to = selected(field)
		local forward = name == "right"
		local target
		if not key.shift and from ~= to and not chord and not key.alt then
			target = if forward then to else from
		elseif key.meta then
			local start, finish = lineBounds(field)
			target = if forward then finish else start
		elseif key.alt or key.ctrl then
			target = wordEdge(field, forward)
		else
			target = if forward then following(field) else previous(field)
		end
		move(field, target, key.shift)
		return true
	elseif name == "home" or name == "begin" or name == "end" then
		local start, finish = lineBounds(field)
		local target = if name == "end" then finish else start
		if chord then
			target = if name == "end" then editor.length(field.text) else 0
		end
		move(field, target, key.shift)
		return true
	elseif multiline and (name == "up" or name == "down") then
		local start, finish, startByte, endByte = lineBounds(field)
		local column = field.cursor - start
		local target
		if chord then
			target = if name == "up" then 0 else editor.length(field.text)
		elseif name == "up" then
			local previousLine = field.text:sub(1, math.max(0, startByte - 2))
			local previousStart = (previousLine:match(".*()\n") or 0) + 1
			local line = previousLine:sub(previousStart)
			target = editor.length(previousLine) - editor.length(line) + math.min(column, editor.length(line))
		else
			local nextEnd = field.text:find("\n", endByte + 1, true) or (#field.text + 1)
			local nextLine = field.text:sub(endByte + 1, nextEnd - 1)
			target = math.min(editor.length(field.text), finish + 1 + math.min(column, editor.length(nextLine)))
		end
		move(field, target, key.shift)
		return true
	elseif name == "backspace" or name == "delete" then
		local from, to = selected(field)
		if from == to then
			if name == "backspace" then
				if key.meta then
					from = lineBounds(field)
				elseif key.alt or key.ctrl then
					from = wordEdge(field, false)
				else
					from = previous(field)
				end
			else
				if key.meta then
					local _, finish = lineBounds(field)
					to = finish
				elseif key.alt or key.ctrl then
					to = wordEdge(field, true)
				else
					to = following(field)
				end
			end
		end
		return splice(field, from, to, "", from)
	elseif name == "enter" and multiline and not chord and not key.alt then
		local from, to = selected(field)
		return splice(field, from, to, "\n", from + 1)
	elseif key.text and not chord then
		local text = if multiline then key.text else key.text:gsub("[\r\n]", " ")
		local from, to = selected(field)
		return splice(field, from, to, text, from + editor.length(text))
	end
	return false
end

return editor
