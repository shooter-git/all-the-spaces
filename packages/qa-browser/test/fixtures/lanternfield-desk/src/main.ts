// A small creation that uses a connector (the fictional Lanternfield Library), for testing the checks:
// it lists the shelves and your loans, and borrows a book when you tap. The checks answer its
// calls from qa/connectors; nothing leaves the machine.
import { ConnectorError, connect } from '@allthespaces/portal';

const LIBRARY = 'lanternfield-library';
const portal = await connect();
const $ = (id: string) => document.getElementById(id) as HTMLElement;

const status = await portal.connectors.status(LIBRARY);
if (!status.linked) $('said').textContent = 'Link your library account to borrow books.';

try {
  const { data } = await portal.connectors.call<{ shelves: string[] }>(LIBRARY, 'listShelves', {
    params: { page: 1 },
  });
  for (const name of data.shelves) {
    const li = document.createElement('li');
    li.textContent = name;
    $('shelves').append(li);
  }
  const loans = await portal.connectors.call<{ loans: string[] }>(LIBRARY, 'getMyLoans');
  $('loans').textContent = `On loan to you: ${loans.data.loans.join(', ') || 'nothing yet'}`;
} catch (err) {
  $('said').textContent = err instanceof ConnectorError ? err.message : 'Something went wrong.';
}

let key = portal.connectors.newKey();
let tries = 0;
$('borrow').addEventListener('click', async () => {
  // Every other tap asks for a book someone else has, to show what a clash looks like.
  const bookId = tries++ % 2 ? '409' : '7';
  try {
    await portal.connectors.call(LIBRARY, 'borrowBook', {
      params: { bookId },
      body: { weeks: 2 },
      idempotencyKey: key,
    });
    $('said').textContent = 'Borrowed for two weeks.';
    key = portal.connectors.newKey();
  } catch (err) {
    if (!(err instanceof ConnectorError)) throw err;
    if (err.code === 'not-linked') await portal.connectors.link(LIBRARY);
    $('said').textContent = err.code === 'clash' ? `Already on loan: ${err.message}` : err.message;
    key = portal.connectors.newKey();
  }
});

portal.ready();
