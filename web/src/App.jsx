import { Route, Routes } from "react-router-dom";
import AgentStage from "./components/AgentStage";
import Landing from "./components/Landing";
import ParticleField from "./components/ParticleField";
import { SiteFooter, SiteHeader } from "./components/SiteChrome";
import Studio from "./components/studio/Studio";

export default function App() {
  return (
    <>
      <div className="glow" aria-hidden="true" />
      <ParticleField />
      <div className="page">
        <SiteHeader />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/a/:slug" element={<AgentStage />} />
          <Route path="/studio" element={<Studio />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        <SiteFooter />
      </div>
    </>
  );
}

function NotFound() {
  return (
    <div className="centered">
      <h1>Nothing here</h1>
      <p style={{ color: "var(--text-muted)" }}>
        That page does not exist. The agents all live under /a/.
      </p>
      <a className="btn" href="/">
        Back to all agents
      </a>
    </div>
  );
}
