#![cfg(test)]
use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

#[test]
fn initialize_stores_wiring() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(Payroll, ());
    let client = PayrollClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury_id = Address::generate(&env);
    let registry_id = Address::generate(&env);
    let token = Address::generate(&env);

    client.initialize(&admin, &treasury_id, &registry_id, &token);
    assert_eq!(client.last_paid(&Address::generate(&env)), 0);
}

// TODO: pay() needs an end-to-end test with a real Treasury and
// EmployeeRegistry registered in the same env. Blocked on deciding whether to
// use contractimport! wasm or register the crates directly in tests.
