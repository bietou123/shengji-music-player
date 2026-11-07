import { createRoot } from "react-dom/client";
import { App, MiniPlayer } from "./App";
import { VisualLayer } from "./Glass";
import "./styles.css";
import "./glass.css";

createRoot(document.getElementById("root")!).render(
  <>{new URLSearchParams(location.search).has("mini") ? <MiniPlayer /> : <App />}<VisualLayer /></>,
);
