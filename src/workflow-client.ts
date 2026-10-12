import { randomUUID } from "node:crypto";
import type { JsonClient } from "./fleet-http.js";
import type { WorkflowItem, WorkflowChange } from "./workflow-store.js";
import {
  tallyFamilyComments,
  AUTO_RETRY_COMMENT_MARKER,
  AUTO_RETRY_RESET_COMMENT_MARKER,
  STRANDED_WIP_OBSERVED_MARKER,
  STRANDED_WIP_SWEPT_MARKER,
} from "./pipeline-decisions.js";

/** Preserve the existing decision functions while changing their storage authority. */
export function workflowClient<T extends object>(
  base: T,
  connection: JsonClient,
  project: string,
  enabled: () => boolean,
  actor: () => { session: string; runId?: string },
): T {
  const read = async () =>
    (
      await connection.call<{ items: WorkflowItem[] }>("/workflow/read", {
        project,
      })
    ).items;
  const change = async (number: number, value: WorkflowChange) =>
    connection.call("/workflow/change", {
      project,
      ticket: `${project}#${number}`,
      change: value,
      commandId: randomUUID(),
      ...actor(),
    });
  const comments = async (number: number) =>
    connection.call<Array<{ body: string; created_at: string }>>(
      "/workflow/comments",
      { project, ticket: `${project}#${number}` },
    );
  const latest = (
    cs: Array<{ body: string; created_at: string }>,
    marker: string,
  ) => {
    const hits = cs
      .filter((c) => c.body.includes(marker))
      .map((c) => Date.parse(c.created_at));
    return hits.length ? new Date(Math.max(...hits)) : null;
  };
  const retry = async (n: number) => {
    let cs = await comments(n);
    let reset = -1;
    cs.forEach((c, i) => {
      if (
        c.body.startsWith("<!-- fleet-recovery:") &&
        c.body.split("\n")[1] === AUTO_RETRY_RESET_COMMENT_MARKER
      )
        reset = i;
    });
    cs = cs
      .slice(reset + 1)
      .filter((c) => c.body.includes(AUTO_RETRY_COMMENT_MARKER));
    return {
      count: cs.length,
      latestAt: latest(cs, AUTO_RETRY_COMMENT_MARKER),
    };
  };
  const methods: Record<string, (...args: any[]) => Promise<any>> = {
    initialize: async () => {
      const state = await connection.call<any>("/workflow/read", { project });
      (base as any).initializeFromWorkflow(state.config);
    },
    getAllProjectItems: () => read(),
    getOpenProjectItems: async () =>
      (await read()).filter((i) => i.state === "OPEN"),
    getItemsByStatus: async (status: string) =>
      (await read()).filter((i) => i.state === "OPEN" && i.status === status),
    getClosedItemsNotInDone: async () =>
      (await read()).filter((i) => i.state === "CLOSED" && i.status !== "Done"),
    getItemStatus: async (n: number) =>
      (await read()).find((i) => i.issueNumber === n)?.status ?? null,
    getIssueLabels: async (n: number) => {
      const i = (await read()).find((i) => i.issueNumber === n);
      if (!i) throw new Error("Unknown workflow ticket");
      return i.labels;
    },
    getOpenBlockers: async (n: number) => {
      const all = await read(),
        item = all.find((i) => i.issueNumber === n);
      if (!item) throw new Error("Unknown workflow ticket");
      return item.blockedBy
        .filter((b) => b.state === "OPEN")
        .map((b) => b.number);
    },
    addLabel: async (n: number, label: string) => {
      await change(n, { addLabels: [label] });
    },
    removeLabel: async (n: number, label: string) => {
      await change(n, { removeLabels: [label] });
    },
    closeIssue: async (n: number) => {
      await change(n, { state: "CLOSED" });
    },
    recordMergedIssue: async (n: number) => {
      const item = (await read()).find((i) => i.issueNumber === n);
      if (!item) throw new Error("Unknown workflow ticket");
      await change(n, {
        state: "CLOSED",
        status: "Done",
        addLabels: ["merged"],
        removeLabels: item.labels.filter((l) =>
          /^(done:|wip:|needs-rework:|error:|pending-done:|pending-verdict:|merge-attempt:)/.test(
            l,
          ),
        ),
      });
    },
    updateItemStatus: async (id: string, status: string) => {
      const i = (await read()).find((i) => i.id === id);
      if (!i) throw new Error("Unknown workflow item");
      await change(i.issueNumber, { status });
    },
    moveItemToTop: async (id: string) => {
      const i = (await read()).find((i) => i.id === id);
      if (!i) throw new Error("Unknown workflow item");
      await change(i.issueNumber, { top: true });
    },
    addBlocker: async (n: number, b: number) => {
      const all = await read(),
        i = all.find((i) => i.issueNumber === n),
        blocker = all.find((i) => i.issueNumber === b);
      if (!i || !blocker || n === b)
        throw new Error("Invalid workflow blocker");
      await change(n, {
        blockedBy: [
          ...i.blockedBy.filter((x) => x.number !== b),
          { number: b, state: blocker.state, url: blocker.url },
        ],
      });
    },
    removeBlocker: async (n: number, b: string) => {
      const i = (await read()).find((i) => i.issueNumber === n);
      if (!i) throw new Error("Unknown workflow ticket");
      const match = b.match(/^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/);
      if (!match) throw new Error("Invalid blocker ticket");
      await change(n, {
        blockedBy: i.blockedBy.filter((x) =>
          x.url
            ? x.url !== `https://github.com/${match[1]}/issues/${match[2]}`
            : match[1] !== project || x.number !== Number(match[2]),
        ),
      });
    },
    listOpenIssuesWithLabel: async (label: string) =>
      (await read())
        .filter((i) => i.state === "OPEN" && i.labels.includes(label))
        .map((i) => ({
          number: i.issueNumber,
          nodeId: i.issueId,
          title: i.title,
          body: i.body,
        })),
    addComment: async (n: number, body: string) => {
      await connection.call("/workflow/comment", {
        project,
        ticket: `${project}#${n}`,
        body,
        commandId: randomUUID(),
        ...actor(),
      });
    },
    getIssueCommentBodies: async (n: number) =>
      (base as any).getIssueCommentBodies(n),
    getFamilyDispatchState: async (n: number) =>
      tallyFamilyComments(await comments(n)),
    getLatestRetryAt: async (n: number) => (await retry(n)).latestAt,
    countRetryMarkers: async (n: number) => (await retry(n)).count,
    countMarkerComments: async (n: number, marker: string) =>
      (await comments(n)).filter((c) => c.body.includes(marker)).length,
    getStrandedWipMarkers: async (n: number) => {
      const cs = await comments(n);
      return {
        observedAt: latest(cs, STRANDED_WIP_OBSERVED_MARKER),
        sweptAt: latest(cs, STRANDED_WIP_SWEPT_MARKER),
      };
    },
  };
  return new Proxy(base, {
    get(target, key) {
      const original: any = Reflect.get(target, key);
      if (
        typeof key === "string" &&
        methods[key] &&
        (enabled() || typeof original === "function")
      )
        return (...args: any[]) =>
          enabled() ? methods[key](...args) : original.apply(target, args);
      return typeof original === "function" ? original.bind(target) : original;
    },
  });
}
