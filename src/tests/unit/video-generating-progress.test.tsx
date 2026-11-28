import { cleanup, render, screen } from "@testing-library/react";

import { VideoGeneratingProgress } from "@/components/video/parts/video-generating-progress";

describe("视频生成进度", () => {
  afterEach(cleanup);

  it("显示排队等待和历史入口说明，不用时间伪造进度", () => {
    render(<VideoGeneratingProgress />);

    expect(screen.getByRole("status")).toHaveTextContent("排队或生成中");
    expect(screen.getByText(/历史记录/)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/预计|即将完成|%/)).not.toBeInTheDocument();
  });
});
