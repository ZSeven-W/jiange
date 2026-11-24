import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { t } from "@/lib/i18n";
import { SheetPreview } from "./sheet-preview";

// This standalone HTML is served by Vite during development only and is not
// an application route or a substitute for persisted workbook integration.
createRoot(document.getElementById("root")!).render(import.meta.env.DEV ? <StrictMode><SheetPreview /></StrictMode> : <p>{t("此预览仅用于开发。")}</p>);
