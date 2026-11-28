// The label of the main service: SKOOBI_SERVICE_LABEL, else the instance
// profile (launchd.mainLabel). The resolver lives in
// @skoobi/shared/launchd-services, next to the job list, because the Telegram
// /status command asks launchd about the same label as the panel.
export {
  resolveMainServiceLabel,
  validateMainServiceLabel,
} from '@skoobi/shared/launchd-services';
