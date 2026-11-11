import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import Navigation from "./Navigation";

vi.mock("./Sidebar", () => ({ default: () => <div>대화 목록</div> }));
afterEach(() => vi.useRealTimers());

it("홈만 지연 호버로 표시하고 메인 탭은 변경하지 않는다", () => {
  vi.useFakeTimers();
  const onChange = vi.fn();
  render(<MemoryRouter><Navigation tab="work" onChange={onChange} /></MemoryRouter>);
  expect(screen.queryByLabelText("홈 대화 히스토리")).toBeNull();
  fireEvent.mouseEnter(screen.getByRole("tab", { name: "홈" }));
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByText("대화 목록")).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("tab", { name: "설정" })).toBeNull();
  for (const name of ["업무", "문서"]) {
    fireEvent.mouseEnter(screen.getByRole("tab", { name }));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText("대화 목록")).toBeNull();
  }
});

it("클릭으로 열고 Escape와 외부 클릭으로 닫는다", () => {
  render(<MemoryRouter><Navigation tab="home" onChange={vi.fn()} /></MemoryRouter>);
  const home = screen.getByRole("tab", { name: "홈" });
  fireEvent.click(home);
  expect(screen.getByText("대화 목록")).toBeInTheDocument();
  fireEvent.keyDown(home, { key: "Escape" });
  expect(screen.queryByText("대화 목록")).toBeNull();
  fireEvent.click(home);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByText("대화 목록")).toBeNull();
});
