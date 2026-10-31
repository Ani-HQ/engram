import { describe, expect, test } from "bun:test";

const { handoffPickUp, SERVER_INSTRUCTIONS } = require("../shim/instructions.js");
const taskId = `task_${"a".repeat(32)}`;

describe("handoff pick-up prompt", () => {
  test("names the task and how to load it", () => {
    const pickUp = handoffPickUp(taskId, "Fix invite errors");
    expect(pickUp.prompt).toBe(`Pick up my engram task "Fix invite errors" (${taskId}). Load it with resume_task, recheck the repo and tests, then keep going from its next step.`);
    expect(pickUp.say).toContain("Keep building");
  });

  test("cleans titles so the prompt stays one pasteable line", () => {
    const { prompt } = handoffPickUp(taskId, 'Ship "v2"\n```rm -rf```\t now');
    expect(prompt).not.toMatch(/[\n\t`]/);
    expect(prompt).toContain('"Ship v2 rm -rf now"');
    expect(handoffPickUp(taskId, "x".repeat(400)).prompt.length).toBeLessThan(300);
  });

  test("falls back to the task ID and refuses anything that is not one", () => {
    expect(handoffPickUp(taskId, "  ").prompt).toStartWith(`Pick up my engram task ${taskId}.`);
    expect(handoffPickUp("task_123", "x")).toBeNull();
    expect(handoffPickUp(undefined, "x")).toBeNull();
  });

  test("server instructions ask agents to show it", () => {
    expect(SERVER_INSTRUCTIONS).toContain("pickUp");
  });
});
