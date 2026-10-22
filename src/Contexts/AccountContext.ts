import { createContext } from "react";

export type Account = { email: string; logout: () => Promise<void> };

export const AccountContext = createContext<Account | null>(null);
