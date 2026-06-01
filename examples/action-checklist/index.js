const tabTypeId = "examples.action-checklist.checklist";
const stateKey = "checklist";
const seededItems = ["Slice A", "Slice B", "Slice C", "Slice D", "Slice E"].map((label, index) => ({ id: `slice-${String.fromCharCode(97 + index)}`, label, completed: index < 3 }));

function project(entry) {
  const items = entry?.value?.items ?? seededItems;
  const completed = items.filter((item) => item.completed).length;
  return {
    items,
    revision: entry?.revision ?? null,
    summary: { kind: "checklist-progress", completed, total: items.length, label: `${completed}/${items.length} complete` },
    badges: [{ id: "remaining", kind: "count", label: `${items.length - completed} remaining` }],
  };
}

export async function activate(ctx) {
  return ctx.architect.tabs.register({
    id: tabTypeId,
    title: "Action Checklist",
    icon: "checklist",
    renderer: "checklist",
    planConnectivity: "required",
    stateSchema: { type: "object" },
    actions: [{ id: "toggle", inputSchema: { type: "object", required: ["type", "itemId"], properties: { type: { type: "string" }, itemId: { type: "string" } } } }],
    sidebarSummary: { kind: "checklist-progress" },
    badges: [{ id: "remaining", kind: "count" }],
    async loadState(context) {
      const entry = await ctx.architect.planState.read(stateKey, context);
      if (entry) return project(entry);
      return project(await ctx.architect.planState.write(stateKey, { items: seededItems }, { ...context, revision: null }));
    },
    async handleAction(action, context) {
      const entry = await ctx.architect.planState.read(stateKey, context);
      const items = (entry?.value?.items ?? seededItems).map((item) => item.id === action.itemId ? { ...item, completed: !item.completed } : item);
      const stored = await ctx.architect.planState.write(stateKey, { items }, { ...context, revision: context.revision });
      return project(stored);
    },
  });
}
