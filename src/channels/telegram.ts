// Обвязка Telegram-канала переехала в пакет (волна 9a, 2026-07-07):
// @skoobi/channel-telegram/wiring — один host+registerChannel на все сборки
// вместо копии в каждом инстансе. Импорт side-effect'ом регистрирует канал,
// как и раньше делал этот файл.
import '@skoobi/channel-telegram/wiring';
