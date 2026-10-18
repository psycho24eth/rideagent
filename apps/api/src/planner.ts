import { plannerActionSchema } from "./schemas.js";
import type { PlannerAction, PlannerInput, PlannerModel } from "./types.js";

const confirmation = /^(yes|yep|yeah|sure|ok|okay|proceed|book(?: it)?|do it|confirm)\b/i;
const rejection = /^(no|nope|don't|do not|cancel|not now|stop)\b/i;
const airport = /\b(airport|terminal|t[1-3]\b|igi|indira gandhi)\b/i;

export class DemoPlanner implements PlannerModel {
  async plan(input: PlannerInput): Promise<PlannerAction> {
    const message = input.message.trim();
    let action: PlannerAction;
    if (input.hasPendingRecommendation && confirmation.test(message)) action = { kind: "confirm" };
    else if (input.hasPendingRecommendation && rejection.test(message)) action = { kind: "reject" };
    else if (input.hasPendingRecommendation) action = { kind: "unclear" };
    else if (airport.test(message)) action = { kind: "request_ride", destination: { label: "Airport" } };
    else action = { kind: "unclear" };
    return plannerActionSchema.parse(action);
  }
}
