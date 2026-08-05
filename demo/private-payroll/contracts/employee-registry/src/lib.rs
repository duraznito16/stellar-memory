#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// Salary in stroops for a given employee.
    Salary(Address),
}

#[contract]
pub struct EmployeeRegistry;

#[contractimpl]
impl EmployeeRegistry {
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Add or update an employee's salary band.
    pub fn set_salary(env: Env, employee: Address, amount: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let key = DataKey::Salary(employee.clone());
        env.storage().persistent().set(&key, &amount);
        env.storage().persistent().extend_ttl(&key, 100_000, 200_000);

        env.events()
            .publish((Symbol::new(&env, "salary_set"), employee), amount);
    }

    /// Remove an employee from the registry.
    pub fn remove(env: Env, employee: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage()
            .persistent()
            .remove(&DataKey::Salary(employee));
    }

    /// Salary for an employee, or 0 if they are not registered.
    pub fn salary_of(env: Env, employee: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Salary(employee))
            .unwrap_or(0)
    }
}
