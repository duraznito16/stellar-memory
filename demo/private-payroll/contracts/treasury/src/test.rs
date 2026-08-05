#![cfg(test)]
use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

#[test]
fn fund_increases_balance() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(Treasury, ());
    let client = TreasuryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let payroll = Address::generate(&env);
    let token = Address::generate(&env);

    client.initialize(&admin, &payroll);
    assert_eq!(client.fund(&token, &1_000), 1_000);
    assert_eq!(client.balance(&token), 1_000);
}

#[test]
fn withdraw_reduces_balance() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(Treasury, ());
    let client = TreasuryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let payroll = Address::generate(&env);
    let token = Address::generate(&env);
    let employee = Address::generate(&env);

    client.initialize(&admin, &payroll);
    client.fund(&token, &1_000);

    assert_eq!(client.withdraw(&token, &employee, &400), 600);
    assert_eq!(client.balance(&token), 600);
}

#[test]
fn withdraw_rejects_overdraft() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(Treasury, ());
    let client = TreasuryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let payroll = Address::generate(&env);
    let token = Address::generate(&env);
    let employee = Address::generate(&env);

    client.initialize(&admin, &payroll);
    client.fund(&token, &100);

    assert!(client.try_withdraw(&token, &employee, &500).is_err());
}
