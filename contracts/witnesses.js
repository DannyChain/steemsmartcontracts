/* eslint-disable no-await-in-loop */
/* global actions, api */

const NB_VOTES_ALLOWED = 30;
const NB_WITNESSES = 9;
const NB_BACKUP_WITNESSES = 1;

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('witnesses');

  if (tableExists === false) {
    await api.db.createTable('witnesses', ['approvalWeight']);
    await api.db.createTable('votes', ['from', 'to']);
    await api.db.createTable('accounts', ['account']);
    await api.db.createTable('params');

    const params = {
      totalApprovalWeight: { $numberDecimal: '0' },
      numberOfApprovedWitnesses: 0,
    };

    await api.db.insert('params', params);
  }
};

const updateWitnessRank = async (witness, approvalWeight) => {
  // check if witness exists
  const witnessRec = await api.db.findOne('witnesses', { account: witness });

  if (witnessRec) {
    // update witness approvalWeight
    const oldApprovalWeight = witnessRec.approvalWeight.$numberDecimal;
    witnessRec.approvalWeight.$numberDecimal = api.BigNumber(
      witnessRec.approvalWeight.$numberDecimal,
    )
      .plus(approvalWeight)
      .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');

    await api.db.update('witnesses', witnessRec);

    const params = await api.db.findOne('params', {});

    // update totalApprovalWeight
    params.totalApprovalWeight.$numberDecimal = api.BigNumber(
      params.totalApprovalWeight.$numberDecimal,
    )
      .plus(approvalWeight)
      .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');

    // update numberOfApprovedWitnesses
    if (api.BigNumber(oldApprovalWeight).eq(0)
      && api.BigNumber(witnessRec.approvalWeight.$numberDecimal).gt(0)) {
      params.numberOfApprovedWitnesses += 1;
    } else if (api.BigNumber(oldApprovalWeight).gt(0)
      && api.BigNumber(witnessRec.approvalWeight.$numberDecimal).eq(0)) {
      params.numberOfApprovedWitnesses -= 1;
    }

    await api.db.update('params', params);
  }
};

actions.updateWitnessesVotes = async () => {
  const acct = await api.db.findOne('accounts', { account: api.sender });

  if (acct !== null) {
    // calculate approval weight of the account
    const balance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });
    let approvalWeight = 0;
    if (balance && balance.stake) {
      approvalWeight = balance.stake;
    }

    if (balance && balance.delegationsIn) {
      approvalWeight = api.BigNumber(approvalWeight).plus(balance.delegationsIn).toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');
    }

    const oldApprovalWeight = acct.approvalWeight;

    const deltaApprovalWeight = api.BigNumber(approvalWeight).minus(oldApprovalWeight).toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');

    acct.approvalWeight = approvalWeight;

    if (!api.BigNumber(deltaApprovalWeight).eq(0)) {
      await api.db.update('accounts', acct);

      const votes = await api.db.find('votes', { from: api.sender });

      for (let index = 0; index < votes.length; index += 1) {
        const vote = votes[index];

        await updateWitnessRank(vote.to, deltaApprovalWeight);
      }
    }
  }
};

actions.register = async (payload) => {
  const {
    IP, RPCPort, P2PPort, signingKey, enabled, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'active key required')
    && api.assert(IP && typeof IP === 'string' && IP.length <= 15, 'IP must be a string with a max. of 15 chars.')
    && api.assert(RPCPort && Number.isInteger(RPCPort) && RPCPort >= 0 && RPCPort <= 65535, 'RPCPort must be an integer between 0 and 65535')
    && api.assert(P2PPort && Number.isInteger(P2PPort) && P2PPort >= 0 && P2PPort <= 65535, 'P2PPort must be an integer between 0 and 65535')
    && api.assert(api.validator.isAlphanumeric(signingKey) && signingKey.length === 53, 'invalid signing key')
    && api.assert(typeof enabled === 'boolean', 'enabled must be a boolean')) {
    let witness = await api.db.findOne('witnesses', { account: api.sender });

    // if the witness is already registered
    if (witness) {
      witness.IP = IP;
      witness.RPCPort = RPCPort;
      witness.P2PPort = P2PPort;
      witness.signingKey = signingKey;
      witness.enabled = enabled;
      await api.db.update('witnesses', witness);
    } else {
      witness = {
        account: api.sender,
        approvalWeight: { $numberDecimal: '0' },
        signingKey,
        IP,
        RPCPort,
        P2PPort,
        enabled,
      };
      await api.db.insert('witnesses', witness);
    }
  }
};

actions.vote = async (payload) => {
  const { witness } = payload;

  if (api.assert(witness && typeof witness === 'string' && witness.length >= 3 && witness.length <= 16, 'invalid witness account')) {
    // check if witness exists
    const witnessRec = await api.db.findOne('witnesses', { account: witness });


    if (api.assert(witnessRec, 'witness does not exist')) {
      let acct = await api.db.findOne('accounts', { account: api.sender });

      if (acct === null) {
        acct = {
          account: api.sender,
          votes: 0,
          approvalWeight: { $numberDecimal: '0' },
        };

        await api.db.insert('accounts', acct);
      }

      // a user can vote for NB_VOTES_ALLOWED witnesses only
      if (api.assert(acct.votes < NB_VOTES_ALLOWED, `you can only vote for ${NB_VOTES_ALLOWED} witnesses`)) {
        let vote = await api.db.findOne('votes', { from: api.sender, to: witness });

        if (api.assert(vote === null, 'you already voted for this witness')) {
          vote = {
            from: api.sender,
            to: witness,
          };
          await api.db.insert('votes', vote);

          // update the rank of the witness that received the vote
          const balance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });
          let approvalWeight = 0;
          if (balance && balance.stake) {
            approvalWeight = balance.stake;
          }

          if (balance && balance.delegationsIn) {
            approvalWeight = api.BigNumber(approvalWeight).plus(balance.delegationsIn).toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');
          }

          acct.votes += 1;
          acct.approvalWeight.$numberDecimal = approvalWeight;

          await api.db.update('accounts', acct);

          if (api.BigNumber(approvalWeight).gt(0)) {
            await actions.updateWitnessRank(witness, approvalWeight);
          }
        }
      }
    }
  }
};

actions.unvote = async (payload) => {
  const { witness } = payload;

  if (api.assert(witness && typeof witness === 'string' && witness.length >= 3 && witness.length <= 16, 'invalid witness account')) {
    // check if witness exists
    const witnessRec = await api.db.findOne('witnesses', { account: witness });


    if (api.assert(witnessRec, 'witness does not exist')) {
      let acct = await api.db.findOne('accounts', { account: api.sender });

      if (acct === null) {
        acct = {
          account: api.sender,
          votes: 0,
          approvalWeight: { $numberDecimal: '0' },
        };

        await api.db.insert('accounts', acct);
      }

      // a user can only unvote if it already voted for a witness
      if (api.assert(acct.votes > 0, 'no votes found')) {
        const vote = await api.db.findOne('votes', { from: api.sender, to: witness });

        if (api.assert(vote !== null, 'you have not voted for this witness')) {
          await api.db.remove('votes', vote);

          const balance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });
          let approvalWeight = 0;
          if (balance && balance.stake) {
            approvalWeight = balance.stake;
          }

          if (balance && balance.delegationsIn) {
            approvalWeight = api.BigNumber(approvalWeight).plus(balance.delegationsIn).toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');
          }

          acct.votes -= 1;
          acct.approvalWeight.$numberDecimal = approvalWeight;

          await api.db.update('accounts', acct);

          // update the rank of the witness that received the unvote
          if (api.BigNumber(approvalWeight).gt(0)) {
            await updateWitnessRank(witness, `-${approvalWeight}`);
          }
        }
      }
    }
  }
};

const scheduleWitnesses = async () => {
  const params = api.db.findOne('params', {});
  const { numberOfApprovedWitnesses, totalApprovalWeight } = params;
  const schedule = [];

  // there has to be enough top witnesses to start a schedule
  if (numberOfApprovedWitnesses >= NB_WITNESSES) {
    // pick the top (NB_WITNESSES - NB_BACKUP_WITNESSES) witnesses
    const nbTopWitnesses = NB_WITNESSES - NB_BACKUP_WITNESSES;
    let approvalWeightTopWitnesses = 0;

    let witnesses = await api.db.find(
      'witnesses',
      {
        approvalWeight: {
          $gt: '0',
        },
        enabled: true,
      },
      nbTopWitnesses, // limit
      0, // offset
      [
        { index: 'approvalWeight', descending: true },
      ],
    );

    for (let index = 0; index < witnesses.length; index += 1) {
      const witness = witnesses[index];
      approvalWeightTopWitnesses += witness.approvalWeight;
      schedule.push(witness.account);
    }

    // pick the backup witnesses

    // get a deterministic random number
    const random = api.random();
    const randomWeight = random * (totalApprovalWeight - approvalWeightTopWitnesses - 1) + 1;
  }
};
