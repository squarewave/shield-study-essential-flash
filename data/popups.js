const port = self.port;

window.onload = () => {
  for (let element of document.querySelectorAll("[data-event]")) {
    element.addEventListener('click', () => {
      const [eventType, data] = element.dataset.event.split(":");
      if (eventType == "form-submit") {
        let dict = {};
        for (let formElement of document.forms[data]) {
          let isInput = formElement instanceof HTMLInputElement;

          if (isInput && formElement.type == "radio") {
            if (formElement.checked) {
              dict[formElement.name] = formElement.value;
            }
          } else if (isInput && formElement.type == "checkbox") {
            if (formElement.checked) {
              dict[formElement.name] = formElement.value;
            }
          } else {
            dict[formElement.name] = formElement.value;
          }
        }

        dict.name = data;
        port.emit(eventType, dict);

        document.forms[data].reset();
      } else {
        port.emit(eventType, data);
      }
    });
  }

  let showing = null;
  port.on("show-view", (name) => {
    if (showing) {
      showing.hidden = true;
    }

    showing = document.getElementById(name);
    showing.hidden = false;
  });
};

port.on("run-test-script", ({script, id, arg}) => {
  const runnableStr = `(() => {
    return (${script});
  })();`;

  try {
    const runnable = eval(runnableStr);
    const result = runnable.call(this, arg);
    port.emit("script-done", { id, result });
  } catch (e) {
    port.emit("script-done", { id, error: e.toString() });
  }
});
