import {
  Fragment,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { describe, expect, it } from "vitest";

import { EntityBlock, StructuredValue, parseStructuredJson } from "../explorer/src/Inspector.js";
import type { ExplorerNodeType, NodeRecord } from "../explorer/src/types.js";

function serializeTree(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(serializeTree).join("");
  if (!isValidElement(node)) return "";

  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === Fragment) return serializeTree(element.props.children as ReactNode);
  if (typeof element.type === "function") {
    return serializeTree(element.type(element.props));
  }

  const className = typeof element.props.className === "string"
    ? ` class="${element.props.className}"`
    : "";
  return `<${String(element.type)}${className}>${serializeTree(element.props.children as ReactNode)}</${String(element.type)}>`;
}

const nodeTypes: ExplorerNodeType[] = [
  "feature",
  "workflow",
  "data_model",
  "capability",
  "datastore",
  "ui_element",
  "dream_node",
  "tension",
];

function record(type: ExplorerNodeType): NodeRecord {
  return {
    id: `${type}_node`,
    type,
    label: `${type} node`,
    degree: 1,
    health: 1,
    confidence: 0.9,
    entity: {
      id: `${type}_node`,
      name: `${type} node`,
      description: "A semantically rich node used to verify the shared Explorer inspector.",
      links: [{
        target: "shared_target",
        type: "feature",
        relationship: "supports",
        strength: "weak",
        meta: { confidence: 0.91, selected_by: "enrich_parser_nodes/1.1" },
      }],
      enrichment: {
        enriched: true,
        model: "gpt-5.6-sol",
        semantic_cache: { coverage: 1, context_hops: 3, conflicts: [] },
      },
    },
    outgoing: [],
    incoming: [],
  };
}

describe("Explorer structured inspector", () => {
  it("parses only valid stringified JSON containers", () => {
    expect(parseStructuredJson('{"enriched":true}')).toEqual({ enriched: true });
    expect(parseStructuredJson('[{"target":"feature_a"}]')).toEqual([{ target: "feature_a" }]);
    expect(parseStructuredJson("ordinary description prose")).toBe("ordinary description prose");
    expect(parseStructuredJson("{not valid json}")).toBe("{not valid json}");
  });

  it("formats stringified contracts and nested arrays without emitting raw JSON", () => {
    const markup = serializeTree(createElement(StructuredValue, {
      value: '{"inputs":[{"name":"items","type":"Item[]","required":true}],"outputs":[{"name":"rendered_view","type":"ui"}]}',
      path: ["data_contract"],
      onNavigate: () => undefined,
    }));

    expect(markup).toContain("Inputs");
    expect(markup).toContain("Outputs");
    expect(markup).toContain("rendered_view");
    expect(markup).toContain("structured-card");
    expect(markup).not.toContain("{&quot;");
  });

  it.each(nodeTypes)("formats links and enrichment for %s nodes through the shared path", (type) => {
    const markup = serializeTree(createElement(EntityBlock, {
      record: record(type),
      onNavigate: () => undefined,
    }));

    expect(markup).toContain("Links");
    expect(markup).toContain("Enrichment");
    expect(markup).toContain("Semantic Cache");
    expect(markup).toContain("Context Hops");
    expect(markup).toContain("structured-entity-link");
    expect(markup).toContain("shared_target");
    expect(markup).not.toContain("{&quot;target&quot;");
  });
});
