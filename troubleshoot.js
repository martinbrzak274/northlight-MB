/*
 * Click-through decision tree for "no internet". Plain JavaScript, no libraries.
 * Everything on screen is added with textContent, never as HTML.
 */
(function () {
  'use strict';

  // q: a yes/no question. end: a final answer. kind: 'good' = solved, 'end' = needs someone else.
  var TREE = {
    start: { q: 'Is the problem on every device (phones and other computers) on this network?', yes: 'lights', no: 'connected' },

    // Whole network is down
    lights: { q: 'Are the modem/router lights normal (power on, internet/WAN light on, no red light)?', yes: 'outage', no: 'restartRouter' },
    outage: { q: 'The lights look fine but nothing works. Check the ISP\'s outage page using mobile data. Is there a known outage?', yes: 'waitIsp', no: 'restartRouter' },
    restartRouter: { q: 'Restart the modem/router: unplug its power for 30 seconds, plug it back in and wait 3 minutes. Is the internet back?', yes: 'solved', no: 'callIsp' },
    waitIsp: { end: 'This is on the provider\'s side. Wait for the outage to be fixed. Use mobile data or a phone hotspot in the meantime.', kind: 'end' },
    callIsp: { end: 'Contact the internet provider. Tell them: since when it has failed, which lights are on or red on the modem/router, and that a restart did not help.', kind: 'end' },

    // Only this computer
    connected: { q: 'Does this computer show as connected (Wi-Fi connected, or the cable is plugged in and its link light is on)?', yes: 'ipTest', no: 'reconnect' },
    reconnect: { q: 'Turn Wi-Fi off and on again, or reseat the cable and try another port. Is the internet back?', yes: 'solved', no: 'restartPc' },
    ipTest: { q: 'Connected, but no internet. Does http://1.1.1.1 open in the browser (an address, not a name)?', yes: 'dns', no: 'routerPage' },
    dns: { end: 'The internet works but names do not resolve: a DNS problem. Ask IT to check this computer\'s DNS servers. Compare with another device on the same network.', kind: 'end' },
    routerPage: { q: 'Does the router\'s own page open (usually http://192.168.0.1 or http://192.168.1.1)?', yes: 'vpn', no: 'restartPc' },
    vpn: { q: 'The router answers but nothing beyond it. Are you using a VPN or proxy? Turn it off. Is the internet back?', yes: 'solved', no: 'restartPc' },
    restartPc: { q: 'Restart this computer. Is the internet back?', yes: 'solved', no: 'escalate' },
    escalate: { end: 'Ask IT for help. Run node tools/network-doctor.js and include its output in your ticket.', kind: 'end', link: { href: 'helpdesk.html', text: 'Open a helpdesk ticket' } },

    solved: { end: 'Great, you are back online. Nothing else to do.', kind: 'good' }
  };

  var card = document.getElementById('card');
  var backBtn = document.getElementById('back');
  var history = ['start'];

  function add(tag, text, parent) {
    var n = document.createElement(tag);
    n.textContent = text;
    parent.appendChild(n);
    return n;
  }

  function go(id) {
    history.push(id);
    render();
  }

  function render() {
    var id = history[history.length - 1];
    var node = TREE[id];
    card.textContent = '';
    card.className = node.end ? node.kind : '';
    add('p', 'Step ' + history.length, card).className = 'step';

    if (node.end) {
      add('p', node.end, card);
      if (node.link) {
        var a = add('a', node.link.text, card);
        a.href = node.link.href;
      }
    } else {
      add('p', node.q, card);
      var row = document.createElement('div');
      row.className = 'answers';
      [['Yes', node.yes], ['No', node.no]].forEach(function (pair) {
        var b = add('button', pair[0], row);
        b.type = 'button';
        b.addEventListener('click', function () { go(pair[1]); });
      });
      card.appendChild(row);
    }
    backBtn.disabled = history.length === 1;
  }

  backBtn.addEventListener('click', function () {
    if (history.length > 1) { history.pop(); render(); }
  });
  document.getElementById('restart').addEventListener('click', function () {
    history = ['start'];
    render();
  });

  render();
})();
