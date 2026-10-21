import { dailyCashTool } from "./dailyCash.ts";
import { bankDailyTool } from "./bankDaily.ts";
import type { BusinessTool } from "./contracts.ts";

/** Only application-shipped implementations run; user text never supplies executable code. */
export const businessTools: BusinessTool[] = [dailyCashTool, bankDailyTool];
