import type {
  PiWebPlugin,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import { createAddHandoff } from "./add-handoff.ts";
import { createAddPanel } from "./add-panel.ts";
import { renderSkillList } from "./list.ts";
import { createSearchPanel } from "./search-panel.ts";
import { renderMachineStatus } from "./status.ts";
import { renderSkillsStyles } from "./styles.ts";
import { createUpdatePanel } from "./update-panel.ts";

const plugin = {
  apiVersion: 4,
  name: "Skills",
  activate: ({ html, runtimePluginId }) => {
    const addHandoff = createAddHandoff();
    const renderAdd = createAddPanel(html, addHandoff);
    const renderSearch = createSearchPanel(html, addHandoff);
    const update = createUpdatePanel(html);
    const panelId = `${runtimePluginId}:skills`;

    return {
      contributions: {
        actions: [
          {
            id: "skills.open",
            title: "Open Skills",
            description: "Open the machine-wide skills panel",
            group: "Skills",
            run: ({ selectWorkspaceTool }) => {
              selectWorkspaceTool(panelId);
            },
          },
        ],
        workspacePanels: [
          {
            id: "skills",
            title: "Skills",
            render: (context: WorkspacePanelContext) => {
              return html`
                <section class="skills-panel">
                  ${renderSkillsStyles(html)}
                  <header class="skills-hero">
                    <div class="skills-hero-copy">
                      <p class="skills-kicker">Machine-wide</p>
                      <h2>Skills</h2>
                      <p class="skills-lede">
                        Add, inspect, update, and remove the skills Pi loads from the shared
                        universal directory. Changes apply to every workspace on this machine.
                      </p>
                    </div>
                    <div class="skills-hero-mark" aria-hidden="true">✦</div>
                  </header>
                  ${renderMachineStatus(html, context)}
                  <div class="skills-grid">
                    <div class="skills-card">${renderAdd(context)}</div>
                    <div class="skills-card">${renderSearch(context)}</div>
                  </div>
                  <div class="skills-card">${update(context)}</div>
                  <div class="skills-card">
                    ${renderSkillList(html, context, (name) => {
                      update.requestUpdate(context, [name]);
                    })}
                  </div>
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
