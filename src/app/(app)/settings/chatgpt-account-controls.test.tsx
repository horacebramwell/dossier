import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatGPTAccountControls } from "./chatgpt-account-controls";
import { chatgptStatus, chatgptAgent, chatgptPair, chatgptDisconnect } from "./chatgpt-actions";
vi.mock("./chatgpt-actions", () => ({ chatgptStatus: vi.fn(), chatgptAgent: vi.fn(), chatgptPair: vi.fn(), chatgptSelect: vi.fn(), chatgptDisconnect: vi.fn() }));
const account = { clientId: "issued", label: "User · issued", connected: true, planAllowed: true, agentAllowed: false };
beforeEach(() => {
  vi.mocked(chatgptStatus).mockResolvedValue({ ok: true, data: { active: "issued", accounts: [account] } });
  vi.mocked(chatgptAgent).mockResolvedValue({ ok: true, data: undefined });
  vi.mocked(chatgptPair).mockResolvedValue({ ok: true, data: { secret: "one-time-capability", expiresAt: Date.now() + 300000 } });
  vi.mocked(chatgptDisconnect).mockResolvedValue({ ok: true, data: { revoked: false } });
});
it("requires an explicit unchecked-by-default job-agent choice", async () => {
  const user = userEvent.setup(); render(<ChatGPTAccountControls onChange={() => {}} />);
  const consent = await screen.findByRole("checkbox"); expect(consent).not.toBeChecked();
  await user.click(consent); await waitFor(() => expect(chatgptAgent).toHaveBeenCalledWith({ allowed: true }));
  expect(screen.getByRole("link", { name: "Manage usage" })).toHaveAttribute("href", "https://chatgpt.com/#settings/Usage");
});
it("offers local helper pairing, never a browser token field", async () => {
  const user = userEvent.setup(); render(<ChatGPTAccountControls onChange={() => {}} />);
  await screen.findByText(/Connected ·/); await user.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
  expect(await screen.findByText("one-time-capability")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Download local sign-in helper" })).toHaveAttribute("download");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});
it("reports unconfirmed remote revocation", async () => {
  const user = userEvent.setup(); render(<ChatGPTAccountControls onChange={() => {}} />);
  await screen.findByText(/Connected ·/); await user.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(await screen.findByText(/Remote revocation was not confirmed/)).toBeInTheDocument();
});
