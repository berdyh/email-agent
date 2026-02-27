import type { EmailAction } from "../types.js";
import priority from "./priority.action.js";
import junk from "./junk.action.js";
import subscription from "./subscription.action.js";

export const builtInActions: EmailAction[] = [priority, junk, subscription];
