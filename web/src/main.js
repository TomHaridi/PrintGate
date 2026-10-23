import { createApp } from 'vue';
import naive from 'naive-ui';
import App from './App.vue';
import { router } from './router';
import { loadBootstrap } from './store';

const app = createApp(App);
app.use(naive);
app.use(router);

app.mount('#app');
loadBootstrap();
router.isReady().then(() => {
  if (location.hash === '' || location.hash === '#/') {
    router.replace({ name: 'dashboard' });
  }
});

window.addEventListener('pg:unauthorized', () => {
  if (!location.hash.includes('/login') && !location.hash.includes('/setup')) {
    router.replace({ name: 'login' });
  }
});
