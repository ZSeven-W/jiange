import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { OfflineBanner, PwaInstallButton } from "./offline-banner";

describe("OfflineBanner", () => {
  it("renders nothing in normal online state (zero visual clutter)", () => {
    expect(renderToStaticMarkup(<OfflineBanner />)).toBe("");
    expect(
      renderToStaticMarkup(
        <I18nProvider>
          <OfflineBanner status={{ online: true, justReconnected: false }} />
        </I18nProvider>,
      ),
    ).toBe("");
  });

  it("renders the Feishu amber offline pill with role=status when disconnected", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <OfflineBanner status={{ online: false, justReconnected: false }} />
      </I18nProvider>,
    );

    expect(html).toContain('data-offline-banner=""');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("网络已断开，本地草稿已暂存，恢复联网后将自动同步");
    expect(html).not.toContain("data-reconnected-banner");
    expect(html).toContain("bg-[#fff7e6]/95");
    expect(html).toContain("border-[#ffd591]");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("print:hidden");
  });

  it("renders the green reconnected confirmation pill when justReconnected is true", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <OfflineBanner status={{ online: true, justReconnected: true }} />
      </I18nProvider>,
    );

    expect(html).toContain('data-reconnected-banner=""');
    expect(html).toContain('role="status"');
    expect(html).toContain("网络已恢复，正在同步最新内容");
    expect(html).not.toContain("data-offline-banner");
    expect(html).toContain("bg-[#f6ffed]/95");
    expect(html).toContain("border-[#b7eb8f]");
  });

  it("supports top and bottom floating positions", () => {
    const bottomHtml = renderToStaticMarkup(
      <OfflineBanner status={{ online: false, justReconnected: false }} />,
    );
    const topHtml = renderToStaticMarkup(
      <OfflineBanner status={{ online: false, justReconnected: false }} position="top" />,
    );

    expect(bottomHtml).toContain("bottom-4");
    expect(topHtml).toContain("top-3");
  });
});

describe("PwaInstallButton", () => {
  it("renders nothing when PWA installation is not available", () => {
    expect(renderToStaticMarkup(<PwaInstallButton />)).toBe("");
    expect(
      renderToStaticMarkup(
        <PwaInstallButton
          installPrompt={{
            canInstall: false,
            promptInstall: vi.fn(async () => "unavailable" as const),
            dismiss: vi.fn(),
          }}
        />,
      ),
    ).toBe("");
  });

  it("renders the compact Feishu-blue install pill when canInstall is true", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <PwaInstallButton
          installPrompt={{
            canInstall: true,
            promptInstall: vi.fn(async () => "accepted" as const),
            dismiss: vi.fn(),
          }}
        />
      </I18nProvider>,
    );

    expect(html).toContain('data-pwa-install-button=""');
    expect(html).toContain('data-pwa-install-trigger=""');
    expect(html).toContain('data-pwa-install-dismiss=""');
    expect(html).toContain("安装应用");
    expect(html).toContain("将 Jiange 安装到设备");
    expect(html).toContain("关闭安装提示");
    expect(html).toContain("#3370ff");
  });

  it("supports non-dismissible compact variant", () => {
    const html = renderToStaticMarkup(
      <PwaInstallButton
        compact
        dismissible={false}
        installPrompt={{
          canInstall: true,
          promptInstall: vi.fn(async () => "accepted" as const),
          dismiss: vi.fn(),
        }}
      />,
    );

    expect(html).toContain('data-pwa-install-trigger=""');
    expect(html).not.toContain("data-pwa-install-dismiss");
    expect(html).toContain("px-2.5 py-1 text-[12px]");
  });
});
