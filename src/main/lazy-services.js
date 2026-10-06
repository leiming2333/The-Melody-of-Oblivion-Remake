function createLazyServices(factories) {
  const instances = new Map();
  const services = { peek: (name) => instances.get(name) };
  for (const [name, factory] of Object.entries(factories)) {
    Object.defineProperty(services, name, {
      enumerable: true,
      get() {
        if (!instances.has(name)) instances.set(name, factory(services));
        return instances.get(name);
      }
    });
  }
  return services;
}

module.exports = { createLazyServices };
