import { createRoot } from "react-dom/client";
import { App, MiniPlayer } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).has("mini") ? <MiniPlayer /> : <App />,
);
