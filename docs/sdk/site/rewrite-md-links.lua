function Link(el)
  local target = el.target
  if target and target:match("%.md$") and not target:match("^https?://") then
    el.target = target:gsub("%.md$", ".html"):gsub("%.md#", ".html#")
  elseif target and target:match("%.md#") and not target:match("^https?://") then
    el.target = target:gsub("%.md#", ".html#")
  end
  return el
end
