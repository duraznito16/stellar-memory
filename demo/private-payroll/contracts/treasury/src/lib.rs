#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env, Symbol};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The company account allowed to fund and configure the treasury.
    Admin,
    /// The payroll contract permitted to draw funds.
    Payroll,
    /// Balance held per token contract address.
    Balance(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TreasuryError {
    NotAuthorized = 1,
    InsufficientFunds = 2,
    NotInitialized = 3,
}

#[contract]
pub struct Treasury;

#[contractimpl]
impl Treasury {
    /// Set the admin and the payroll contract that may draw from this treasury.
    pub fn initialize(env: Env, admin: Address, payroll: Address) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Payroll, &payroll);
    }

    /// Add funds for a given token. Only the admin may do this.
    pub fn fund(env: Env, token: Address, amount: i128) -> Result<i128, TreasuryError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(TreasuryError::NotInitialized)?;
        admin.require_auth();

        let key = DataKey::Balance(token.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let updated = current + amount;
        env.storage().persistent().set(&key, &updated);
        env.storage().persistent().extend_ttl(&key, 100_000, 200_000);

        env.events().publish((Symbol::new(&env, "funded"), token), updated);
        Ok(updated)
    }

    /// Release funds to an employee. Callable only by the payroll contract.
    pub fn withdraw(
        env: Env,
        token: Address,
        to: Address,
        amount: i128,
    ) -> Result<i128, TreasuryError> {
        let payroll: Address = env
            .storage()
            .instance()
            .get(&DataKey::Payroll)
            .ok_or(TreasuryError::NotInitialized)?;
        payroll.require_auth();

        let key = DataKey::Balance(token.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if current < amount {
            return Err(TreasuryError::InsufficientFunds);
        }

        let remaining = current - amount;
        env.storage().persistent().set(&key, &remaining);
        env.storage().persistent().extend_ttl(&key, 100_000, 200_000);

        // Actually move the funds. Everything above is bookkeeping.
        let client = token::TokenClient::new(&env, &token);
        client.transfer(&env.current_contract_address(), &to, &amount);

        env.events()
            .publish((Symbol::new(&env, "withdrawn"), to), amount);
        Ok(remaining)
    }

    /// Current balance for a token. Refreshes the entry's TTL on read, which is
    /// the idiomatic way to keep a hot key alive — it is maintenance, not a
    /// state change, and needs no authorization.
    pub fn balance(env: Env, token: Address) -> i128 {
        let key = DataKey::Balance(token);
        env.storage().persistent().extend_ttl(&key, 100_000, 200_000);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    /// The payroll contract currently allowed to draw from this treasury.
    pub fn payroll_address(env: Env) -> Result<Address, TreasuryError> {
        env.storage()
            .instance()
            .get(&DataKey::Payroll)
            .ok_or(TreasuryError::NotInitialized)
    }
}

#[cfg(test)]
mod test;
