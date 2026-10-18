// Shared by the practice and sim scripts: where the running server is, and the dashboard token header.
import { localBase, localAuthHeaders } from "../src/config.mjs";

export const BASE = process.env.BASE_URL ?? localBase();
export const authHeaders = localAuthHeaders;
