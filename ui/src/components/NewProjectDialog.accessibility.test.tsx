// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectDialog } from "./NewProjectDialog";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [] }),
  useMutation: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ newProjectOpen: true, closeNewProject: vi.fn() }),
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { name: "Dopai" } }),
}));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => <div role="textbox" aria-label="Description" />,
}));
vi.mock("./PathInstructionsModal", () => ({ ChoosePathButton: () => <button type="button">Choose path</button> }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
    children: ReactNode;
    variant?: string;
    size?: string;
  }) => {
    const { variant: _variant, size: _size, ...buttonProps } = props;
    return <button {...buttonProps}>{children}</button>;
  },
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("NewProjectDialog accessibility", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("names icon controls and uses contrast-safe secondary text", async () => {
    await act(async () => root.render(<NewProjectDialog />));

    expect(container.querySelector('button[aria-label="Expand project dialog"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Close project dialog"]')).toBeTruthy();

    const companyCode = Array.from(container.querySelectorAll("span"))
      .find((element) => element.textContent === "DOP");
    expect(companyCode?.className).toContain("text-neutral-700");

    const optionalLabels = Array.from(container.querySelectorAll("span"))
      .filter((element) => element.textContent === "optional");
    expect(optionalLabels).toHaveLength(2);
    for (const label of optionalLabels) {
      expect(label.className).toContain("text-muted-foreground");
      expect(label.className).not.toContain("text-muted-foreground/50");
    }

    const dateInput = container.querySelector<HTMLInputElement>('input[type="date"]');
    expect(dateInput?.getAttribute("aria-label")).toBe("Target date");
    const focusContainer = dateInput?.closest("[data-focus-visible-container]");
    expect(focusContainer?.className).toContain("focus-within:ring-2");
  });
});
