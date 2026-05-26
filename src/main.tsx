import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AIVoiceAgentDemo from "../ai_voice_agent_demo.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AIVoiceAgentDemo />
  </StrictMode>
);
