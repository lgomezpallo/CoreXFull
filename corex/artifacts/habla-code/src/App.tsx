import { useEffect, useState } from "react";
import { Beaker, Blocks, FolderKanban, Settings2 } from "lucide-react";
import ConversationalBuilder from "@/components/conversational-builder";
import { AuthGate } from "@/components/auth-gate";
import { PrismaChat } from "@/components/prisma-chat";
import { ProjectHub } from "@/components/project-hub";
import { RouterSettings } from "@/components/router-settings";
import type { BuilderProject } from "@/lib/builder-workspace";
import "./corex-shell.css";
import "./chat-send-overrides.css";

type MainSection = "builder" | "projects" | "lab";

function CoreXWorkspace() {
  const [section, setSection] = useState<MainSection>("builder");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeModule, setActiveModule] = useState<"corex" | "prisma">("corex");
  const prismaEnabled = import.meta.env.VITE_ENABLE_PRISMA_CHAT === "true";

  useEffect(() => {
    if (section === "projects") return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (section === "builder") {
        const fromLab = document.querySelector<HTMLButtonElement>('[data-testid="button-show-builder"]');
        if (fromLab) {
          fromLab.click();
          window.clearInterval(timer);
          return;
        }
        const builder = document.querySelector<HTMLButtonElement>('[data-testid="button-open-builder-mode"]');
        if (builder) {
          builder.click();
          window.clearInterval(timer);
          return;
        }
      } else {
        if (document.querySelector('[data-testid="laboratory-workspace"]')) {
          window.clearInterval(timer);
          return;
        }
        const laboratory = document.querySelector<HTMLButtonElement>('[data-testid="button-open-laboratory-mode"]');
        if (laboratory) {
          laboratory.click();
          window.clearInterval(timer);
          return;
        }
      }
      if (attempts >= 30) window.clearInterval(timer);
    }, 40);
    return () => window.clearInterval(timer);
  }, [section]);

  const openProject = (project: BuilderProject) => {
    setActiveModule("corex");
    setSection(project.mode === "lab" ? "lab" : "builder");
  };

  return (
    <div className="corex-app-shell">
      <nav className="corex-primary-nav" aria-label="Navegación principal de CoreX">
        <span className="corex-brand-mini" aria-label="CoreX">CoreX</span>
        <button
          type="button"
          className={!settingsOpen && section === "builder" ? "is-active" : ""}
          onClick={() => { setSettingsOpen(false); setSection("builder"); setActiveModule("corex"); }}
          data-testid="nav-builder"
        >
          <Blocks size={14} /> Builder
        </button>
        <button
          type="button"
          className={!settingsOpen && section === "projects" ? "is-active" : ""}
          onClick={() => { setSettingsOpen(false); setSection("projects"); setActiveModule("corex"); }}
          data-testid="nav-projects"
        >
          <FolderKanban size={14} /> Proyectos
        </button>
        <button
          type="button"
          className={!settingsOpen && section === "lab" ? "is-active" : ""}
          onClick={() => { setSettingsOpen(false); setSection("lab"); setActiveModule("corex"); }}
          data-testid="nav-laboratory"
        >
          <Beaker size={14} /> Laboratorio
        </button>
        <button
          type="button"
          className={settingsOpen ? "is-active" : ""}
          onClick={() => setSettingsOpen(true)}
          data-testid="nav-settings"
        >
          <Settings2 size={14} /> Configuración
        </button>
      </nav>

      <div className="corex-app-content">
        {section === "projects"
          ? <ProjectHub onOpenProject={openProject} />
          : activeModule === "prisma" && prismaEnabled && section === "builder"
            ? <PrismaChat onBack={() => setActiveModule("corex")} />
            : <ConversationalBuilder
                onOpenPrisma={prismaEnabled ? () => setActiveModule("prisma") : undefined}
              />}
      </div>

      <RouterSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function App() {
  return (
    <AuthGate>
      <CoreXWorkspace />
    </AuthGate>
  );
}

export default App;