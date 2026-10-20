import type {
  PiWebPlugin,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import { createAddHandoff } from "./add-handoff.ts";
import { createAddPanel } from "./add-panel.ts";
import { renderSkillList } from "./list.ts";
import { createSearchPanel } from "./search-panel.ts";
import { renderMachineStatus } from "./status.ts";
import { createUpdatePanel } from "./update-panel.ts";

const plugin = {
  apiVersion: 4,
  name: "Skills",
  activate: ({ html }) => {
    const addHandoff = createAddHandoff();
    const renderAdd = createAddPanel(html, addHandoff);
    const renderSearch = createSearchPanel(html, addHandoff);
    const renderUpdate = createUpdatePanel(html);

    return {
      contributions: {
        workspacePanels: [
          {
            id: "skills",
            title: "Skills",
            render: (context: WorkspacePanelContext) => {
              return html`
                <section>
                  <header><h2>Skills</h2></header>
                  <p>
                    This panel manages skills for the whole machine, not for this workspace.
                    Installed skills are available to every workspace on this machine.
                  </p>
                  ${renderMachineStatus(html, context)}
                  ${renderAdd(context)}
                  ${renderSearch(context)}
                  ${renderUpdate(context)}
                  ${renderSkillList(html, context)}
                </section>
              `;
            },
          },
        ],
      },
    };
  },
} satisfies PiWebPlugin;

export default plugin;
