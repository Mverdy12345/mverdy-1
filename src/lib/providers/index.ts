// سجل المزودات — خريطة ProviderId → Adapter
import type { ProviderId } from "../models";
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";
import type { ProviderAdapter } from "./types";

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};
