import { describe, expect, it } from "vitest";
import { planExecutionRecipe } from "../recipe/planner.js";
import { buildExecutionDecisionInput } from "./input.js";

/**
 * Regression / scenario checks for Telegram-style prompts discussed in Stage 86 sessions.
 * Uses the same decision + planner path as production (no live gateway).
 */
describe("Vladimir scenario messages (routing only)", () => {
  const sessionProfile = "media_creator" as const;

  function planWithMediaCreator(prompt: string) {
    const input = buildExecutionDecisionInput({ prompt });
    return {
      input,
      plan: planExecutionRecipe({ ...input, prompt: input.prompt, sessionProfile }),
    };
  }

  it('routes "create two agents" message: expects code/site signals because the text mentions сайт', () => {
    const prompt =
      "Давай создадим агента. Он будет отвечать за сайт, можно просто frontender, и будем с него спрашивать за сайт. Второй агент будет отвечать за игру - змейка";
    const { input, plan } = planWithMediaCreator(prompt);

    expect(input.intent).toBe("code");
    expect(input.artifactKinds ?? []).toEqual(expect.arrayContaining(["site"]));
    expect(plan.recipe.id).toBe("code_build_publish");
    expect(plan.profile.selectedProfile.id).toBe("media_creator");
  });

  it('routes "why prompts, create agents, I want site and snake" follow-up', () => {
    const prompt =
      "А мне зачем эти промпты? Создай агентов, назначь роли и зоны ответственности и следи за исполнением. Я хочу видеть результат просто. Жду сайт и змейку";
    const { input, plan } = planWithMediaCreator(prompt);

    expect(input.intent).toBe("code");
    expect(input.artifactKinds ?? []).toEqual(expect.arrayContaining(["site"]));
    expect(plan.recipe.id).toBe("code_build_publish");
  });
});
