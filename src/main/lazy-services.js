function createLazyServices(factories, { onLoaded } = {}) {
  const instances = new Map();
  const services = { peek: (name) => instances.get(name) };
  for (const [name, factory] of Object.entries(factories)) {
    Object.defineProperty(services, name, {
      enumerable: true,
      get() {
        if (!instances.has(name)) {
          const instance = factory(services);
          instances.set(name, instance);
          onLoaded?.(name);
        }
        return instances.get(name);
      }
    });
  }
  return services;
}

module.exports = { createLazyServices };
