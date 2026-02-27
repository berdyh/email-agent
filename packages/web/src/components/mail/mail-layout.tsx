"use client";

import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { MailList } from "./mail-list";
import { MailDisplay } from "./mail-display";

export function MailLayout() {
  return (
    <PanelGroup direction="horizontal" className="h-full">
      <Panel defaultSize={40} minSize={25}>
        <MailList />
      </Panel>
      <PanelResizeHandle className="w-1 bg-border hover:bg-ring transition-colors" />
      <Panel defaultSize={60} minSize={30}>
        <MailDisplay />
      </Panel>
    </PanelGroup>
  );
}
