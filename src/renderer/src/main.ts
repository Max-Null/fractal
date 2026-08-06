import { createApp } from "vue";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import App from "./App.vue";
import router from "./router";
import "./assets/main.css";
import zh from "./locales/zh.json";
import en from "./locales/en.json";

const i18n = createI18n({
  legacy: false,
  locale: "zh",
  fallbackLocale: "en",
  messages: { zh, en },
});

const pinia = createPinia();
const app = createApp(App);

app.use(pinia);
app.use(i18n);
app.use(router);
app.mount("#app");
