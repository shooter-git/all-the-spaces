import { connect } from '@allthespaces/portal';

// A blank canvas. Everything about the creation is yours: this only shows who's here.
const portal = await connect();
const app = document.querySelector('#app') as HTMLElement;

function render() {
  const names = portal.session.players.map((p) => p.name).join(', ');
  app.innerHTML = '';
  const hello = document.createElement('h1');
  hello.textContent = `Hello, ${portal.me.name}`;
  const here = document.createElement('p');
  here.textContent = `Here now: ${names}`;
  app.append(hello, here);
}
portal.session.onPlayers(render);
render();

portal.ready(); // lifts the app's veil
