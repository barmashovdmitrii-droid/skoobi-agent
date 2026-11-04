// A minimal synthetic state machine. Visible assertions become true only after
// movement completes; the verifier uses normal keyboard/click input, not JS calls.
const variant = 'good';
const world = document.querySelector('#world');
const player = document.querySelector('#player');
const cabin = document.querySelector('#cabin');
const call = document.querySelector('#call-lift');
const deliver = document.querySelector('#deliver');
const journey = document.querySelector('#journey-state');
const lift = document.querySelector('#lift-state');
const resources = document.querySelector('#resource-state');
const inventory = document.querySelector('#inventory');
const state = {
  phase: 'approach',
  playerX: 30,
  playerY: 200,
  cabinY: 40,
  carrying: 1,
  delivered: 0,
};

function paint() {
  player.style.left = `${state.playerX}px`;
  player.style.top = `${state.playerY}px`;
  cabin.style.top = `${state.cabinY}px`;
  inventory.textContent = `Carrying: ${state.carrying}`;
  resources.textContent = `Resources delivered: ${state.delivered}`;
}
function travel(change, finished) {
  const start = performance.now();
  function frame(now) {
    const progress = Math.min(1, (now - start) / 250);
    change(progress);
    paint();
    if (progress < 1) requestAnimationFrame(frame);
    else finished();
  }
  requestAnimationFrame(frame);
}
world.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowRight') return;
  event.preventDefault();
  if (state.phase === 'approach') {
    state.phase = 'crossing';
    travel(
      (p) => {
        state.playerX = 30 + 130 * p;
      },
      () => {
        state.phase = 'waiting';
        journey.textContent = 'Shaft crossed; at lower landing';
        if (call) call.disabled = false;
      },
    );
  } else if (
    state.phase === 'upper' &&
    state.delivered === 1 &&
    state.carrying === 0 &&
    state.playerY === 40
  ) {
    state.phase = 'continuing';
    travel(
      (p) => {
        state.playerX = 160 + 125 * p;
      },
      () => {
        state.phase = 'complete';
        journey.textContent = 'Continued into next area';
      },
    );
  }
});
call?.addEventListener('click', () => {
  if (state.phase !== 'waiting') return;
  call.disabled = true;
  state.phase = 'called';
  lift.textContent = 'Cabin approaching lower landing';
  if (variant === 'stuck-cabin') return;
  travel(
    (p) => {
      state.cabinY = 40 + 160 * p;
    },
    () => {
      state.phase = 'boarding';
      lift.textContent = 'Cabin ready at lower landing';
      deliver.disabled = false;
    },
  );
});
deliver.addEventListener('click', () => {
  if (
    state.phase !== 'boarding' ||
    state.cabinY !== 200 ||
    state.carrying !== 1
  )
    return;
  deliver.disabled = true;
  state.phase = 'transporting';
  lift.textContent = 'Transporting resource to upper level';
  travel(
    (p) => {
      state.cabinY = 200 - 160 * p;
      state.playerY = state.cabinY;
    },
    () => {
      state.carrying = 0;
      state.delivered = 1;
      state.phase = 'upper';
      lift.textContent = 'Cabin at upper level';
      paint();
    },
  );
});
paint();
