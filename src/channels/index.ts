// Built-in channel imports — self-registering on import.
// Each channel returns `null` from its factory when its credentials/env are
// missing, so unconfigured channels are simply skipped at startup.
import './telegram.js';
import './whatsapp.js';
