// Mock for expo-secure-store (native-only; not available in Node test env)
const store = {};
module.exports = {
  getItemAsync: jest.fn(async (key) => store[key] ?? null),
  setItemAsync: jest.fn(async (key, val) => { store[key] = val; }),
  deleteItemAsync: jest.fn(async (key) => { delete store[key]; }),
};
