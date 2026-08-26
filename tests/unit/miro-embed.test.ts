import { describe, expect, it } from "vitest";

import { canonicalMiroBoardUrl, defaultMiroLiveEmbedUrl, miroBoardId, resolveMiroPresentation, safeMiroLiveEmbedUrl } from "@/lib/admin/miro-embed";

describe("Miro public embed URLs", () => {
  it("preserves the validated public sharing id for anonymous direct navigation", () => {
    expect(canonicalMiroBoardUrl("https://miro.com/app/board/uXjVHwbGl-w=/?share_link_id=104117806222")).toBe("https://miro.com/app/board/uXjVHwbGl-w=/?share_link_id=104117806222");
    expect(canonicalMiroBoardUrl("https://miro.com/app/board/uXjVHwbGl-w=/?untrusted=1")).toBeUndefined();
    expect(canonicalMiroBoardUrl("https://evil.example/app/board/uXjVHwbGl-w=/")).toBeUndefined();
    expect(canonicalMiroBoardUrl("https://user:pass@miro.com/app/board/uXjVHwbGl-w=/")).toBeUndefined();
  });

  it("accepts only the documented view-only live embed URL for the same board", () => {
    const value = "https://miro.com/app/live-embed/uXjVHwbGl-w=/?embedMode=view_only_without_ui&moveToViewport=-1.5,2,100,200&autoplay=false";
    expect(safeMiroLiveEmbedUrl(value, "uXjVHwbGl-w=")).toBe("https://miro.com/app/live-embed/uXjVHwbGl-w=/?embedMode=view_only_without_ui&autoplay=false&moveToViewport=-1.5%2C2%2C100%2C200");
    expect(safeMiroLiveEmbedUrl("https://miro.com/app/live-embed/another/?embedMode=view_only_without_ui&moveToWidget=123", "uXjVHwbGl-w=")).toBeUndefined();
    expect(safeMiroLiveEmbedUrl("https://miro.com/app/live-embed/uXjVHwbGl-w=/?embedMode=view_only_without_ui&moveToWidget=123&boardsAccessToken=secret", "uXjVHwbGl-w=")).toBeUndefined();
    expect(safeMiroLiveEmbedUrl("https://miro.com/app/live-embed/uXjVHwbGl-w=/?embedMode=view_only_without_ui&moveToWidget=123&moveToWidget=456", "uXjVHwbGl-w=")).toBeUndefined();
    expect(safeMiroLiveEmbedUrl("https://miro.com/app/live-embed/uXjVHwbGl-w=/?embedMode=view_only_without_ui&moveToWidget=123#fragment", "uXjVHwbGl-w=")).toBeUndefined();
    expect(safeMiroLiveEmbedUrl("https://miro.com/app/live-embed/uXjVHwbGl-w=/?embedMode=view_only_without_ui&moveToWidget=123&moveToViewport=0,0,10,10", "uXjVHwbGl-w=")).toBeUndefined();
    expect(safeMiroLiveEmbedUrl("https://miro.com/app/live-embed/uXjVHwbGl-w=/?embedMode=view_only_without_ui&moveToViewport=0,0,0,10", "uXjVHwbGl-w=")).toBeUndefined();
  });

  it("accepts an unpositioned live embed and has an autoplay fallback for a known board", () => {
    expect(safeMiroLiveEmbedUrl("https://miro.com/app/live-embed/uXjVHwbGl-w=/?embedMode=view_only_without_ui", "uXjVHwbGl-w=")).toBe("https://miro.com/app/live-embed/uXjVHwbGl-w=/?embedMode=view_only_without_ui");
    expect(defaultMiroLiveEmbedUrl("https://miro.com/app/board/uXjVHwbGl-w=/")).toBe("https://miro.com/app/live-embed/uXjVHwbGl-w=/?embedMode=view_only_without_ui&autoplay=true");
  });

  it("derives the configured live embed board from the validated shared board pathname", () => {
    const board = "https://miro.com/app/board/uXjVHwbGl-w=/?share_link_id=104117806222";
    const live = "https://miro.com/app/live-embed/uXjVHwbGl-w=/?embedMode=view_only_without_ui";
    expect(miroBoardId(canonicalMiroBoardUrl(board))).toBe("uXjVHwbGl-w=");
    expect(resolveMiroPresentation(board, live)).toEqual({
      boardUrl: board,
      embedUrl: live,
    });
  });
});
