import type { Page } from "@playwright/test";

export interface ChatOrderItem {
  index: number;
  testId: string | null;
  role: string | null;
  text: string;
  top: number;
}

export interface ChatOrderSnapshot {
  at: number;
  items: ChatOrderItem[];
  firstUserIndex: number;
  assistantIndex: number;
  secondUserIndex: number;
  violated: boolean;
}

export interface ChatOrderReport {
  snapshots: ChatOrderSnapshot[];
  violations: ChatOrderSnapshot[];
  sawFirstUser: boolean;
  sawAssistant: boolean;
  sawSecondUser: boolean;
}

export async function installChatOrderObserver(
  page: Page,
  options: { firstUserText: string; secondUserText: string; maxSnapshots?: number },
): Promise<void> {
  await page.evaluate(({ firstUserText, secondUserText, maxSnapshots }) => {
    const win = window as typeof window & {
      __chatOrderObserver?: MutationObserver;
      __chatOrderState?: ChatOrderReport;
    };

    win.__chatOrderObserver?.disconnect();

    const state: ChatOrderReport = {
      snapshots: [],
      violations: [],
      sawFirstUser: false,
      sawAssistant: false,
      sawSecondUser: false,
    };
    win.__chatOrderState = state;

    let scheduled = false;
    const collect = () => {
      scheduled = false;
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="chat-message"], [data-testid="chat-streaming"]',
        ),
      );
      const items = nodes.map((element, index) => ({
        index,
        testId: element.getAttribute("data-testid"),
        role: element.getAttribute("data-role"),
        text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400),
        top: Math.round(element.getBoundingClientRect().top),
      }));

      const firstUserIndex = items.findIndex(
        (item) => item.testId === "chat-message" && item.role === "user" && item.text.includes(firstUserText),
      );
      const assistantIndex = firstUserIndex === -1
        ? -1
        : items.findIndex(
            (item, index) => index > firstUserIndex && item.role === "assistant",
          );
      const secondUserIndex = items.findIndex(
        (item) => item.testId === "chat-message" && item.role === "user" && item.text.includes(secondUserText),
      );
      const violated = secondUserIndex !== -1 && assistantIndex !== -1 && secondUserIndex < assistantIndex;

      state.sawFirstUser ||= firstUserIndex !== -1;
      state.sawAssistant ||= assistantIndex !== -1;
      state.sawSecondUser ||= secondUserIndex !== -1;

      const snapshot: ChatOrderSnapshot = {
        at: Date.now(),
        items,
        firstUserIndex,
        assistantIndex,
        secondUserIndex,
        violated,
      };
      state.snapshots.push(snapshot);
      if (state.snapshots.length > maxSnapshots) state.snapshots.shift();
      if (violated) state.violations.push(snapshot);
    };

    const scheduleCollect = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(collect);
    };

    const root = document.querySelector('[data-testid="chat-message-list"]') ?? document.body;
    const observer = new MutationObserver(scheduleCollect);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    win.__chatOrderObserver = observer;
    collect();
  }, { ...options, maxSnapshots: options.maxSnapshots ?? 80 });
}

export async function getChatOrderReport(page: Page): Promise<ChatOrderReport> {
  return page.evaluate(() => {
    const state = (window as typeof window & { __chatOrderState?: ChatOrderReport }).__chatOrderState;
    return state ?? {
      snapshots: [],
      violations: [],
      sawFirstUser: false,
      sawAssistant: false,
      sawSecondUser: false,
    };
  });
}

export function formatChatOrderReport(report: ChatOrderReport, maxSnapshots = 8): string {
  const formatSnapshot = (snapshot: ChatOrderSnapshot) => {
    const items = snapshot.items
      .map((item) => `${item.index}:${item.testId || "?"}/${item.role || "?"}@${item.top} ${JSON.stringify(item.text.slice(0, 120))}`)
      .join("\n    ");
    return [
      `at=${new Date(snapshot.at).toISOString()} firstUser=${snapshot.firstUserIndex} assistant=${snapshot.assistantIndex} secondUser=${snapshot.secondUserIndex} violated=${snapshot.violated}`,
      `    ${items}`,
    ].join("\n");
  };

  const snapshots = report.violations.length > 0
    ? report.violations.slice(-maxSnapshots)
    : report.snapshots.slice(-maxSnapshots);

  return [
    `sawFirstUser=${report.sawFirstUser} sawAssistant=${report.sawAssistant} sawSecondUser=${report.sawSecondUser} violations=${report.violations.length}`,
    ...snapshots.map(formatSnapshot),
  ].join("\n\n");
}
