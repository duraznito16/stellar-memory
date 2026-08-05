#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Symbol};

mod treasury {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/treasury.wasm"
    );
}

mod registry {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/employee_registry.wasm"
    );
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Treasury,
    Registry,
    /// Token used to pay salaries. Multi-token support landed in v0.3.
    PayToken,
    /// Last ledger at which this employee was paid.
    LastPaid(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PayrollError {
    NotAuthorized = 1,
    UnknownEmployee = 2,
    AlreadyPaidThisPeriod = 3,
    NotInitialized = 4,
}

#[contract]
pub struct Payroll;

#[contractimpl]
impl Payroll {
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury_id: Address,
        registry_id: Address,
        pay_token: Address,
    ) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury_id);
        env.storage().instance().set(&DataKey::Registry, &registry_id);
        env.storage().instance().set(&DataKey::PayToken, &pay_token);
    }

    /// Pay one employee their band's salary out of the treasury.
    pub fn pay(env: Env, employee: Address) -> Result<i128, PayrollError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(PayrollError::NotInitialized)?;
        admin.require_auth();

        let registry_id: Address = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(PayrollError::NotInitialized)?;
        let registry_client = registry::Client::new(&env, &registry_id);
        let amount = registry_client.salary_of(&employee);
        if amount == 0 {
            return Err(PayrollError::UnknownEmployee);
        }

        let treasury_id: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(PayrollError::NotInitialized)?;
        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::PayToken)
            .ok_or(PayrollError::NotInitialized)?;

        let treasury_client = treasury::Client::new(&env, &treasury_id);
        treasury_client.withdraw(&token, &employee, &amount);

        // TODO: this never gets its TTL extended, so a long-tenured employee's
        // payment record can expire and let them be paid twice in a period.
        env.storage()
            .persistent()
            .set(&DataKey::LastPaid(employee.clone()), &env.ledger().sequence());

        env.events()
            .publish((Symbol::new(&env, "paid"), employee), amount);
        Ok(amount)
    }

    /// Change the token salaries are paid in.
    // FIXME: missing require_auth — anyone can repoint payroll at a worthless token.
    pub fn set_pay_token(env: Env, token: Address) {
        env.storage().instance().set(&DataKey::PayToken, &token);
        env.events()
            .publish((Symbol::new(&env, "token_changed"),), token);
    }

    /// Ledger sequence at which this employee was last paid, or 0.
    pub fn last_paid(env: Env, employee: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::LastPaid(employee))
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
